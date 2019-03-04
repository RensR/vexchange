import React, { Component } from 'react';
import { connect } from 'react-redux';
import PropTypes from 'prop-types';
import classnames from 'classnames';
import {BigNumber as BN} from "bignumber.js";
import MediaQuery from 'react-responsive';
import { withNamespaces } from 'react-i18next';
import ReactGA from 'react-ga';

import { selectors, addPendingTx } from '../../ducks/web3connect';
import Header from '../../components/Header';
import NavigationTabs from '../../components/NavigationTabs';
import CurrencyInputPanel from '../../components/CurrencyInputPanel';
import ContextualInfo from '../../components/ContextualInfo';
import OversizedPanel from '../../components/OversizedPanel';
import DropdownBlue from "../../assets/images/dropdown-blue.svg";
import DropupBlue from "../../assets/images/dropup-blue.svg";
import ArrowDownBlue from '../../assets/images/arrow-down-blue.svg';
import ArrowDownGrey from '../../assets/images/arrow-down-grey.svg';
import { getBlockDeadline } from '../../helpers/web3-utils';
import { retry } from '../../helpers/promise-utils';
import EXCHANGE_ABI from '../../abi/exchange';

import "./swap.scss";

const INPUT = 0;
const OUTPUT = 1;

class Swap extends Component {
  static propTypes = {
    account: PropTypes.string,
    web3: PropTypes.object,
    isConnected: PropTypes.bool.isRequired,
    selectors: PropTypes.func.isRequired,
    addPendingTx: PropTypes.func.isRequired,
  };

  state = {
    inputValue: '',
    outputValue: '',
    inputCurrency: 'VET',
    outputCurrency: '',
    inputAmountB: '',
    lastEditedField: '',
    exchangeFee: '',
  };

  componentDidMount() {
    ReactGA.pageview(window.location.pathname + window.location.search);
  }

  reset() {
    this.setState({
      inputValue: '',
      outputValue: '',
      inputAmountB: '',
      lastEditedField: '',
    });
  }

  componentWillReceiveProps() {
    this.recalcForm();
  }

  validate() {
    const { selectors, account, web3 } = this.props;
    const {
      inputValue, outputValue,
      inputCurrency, outputCurrency,
    } = this.state;

    let inputError = '';
    let outputError = '';
    let isValid = true;
    let extraFee = false;
    let isUnapproved = this.isUnapproved();
    const inputIsZero = BN(inputValue).isZero();
    const outputIsZero = BN(outputValue).isZero();

    if ((inputCurrency && inputCurrency !== 'VET') && (outputCurrency && outputCurrency !== 'VET')) {
      extraFee = true;
    }

    if (!inputValue || inputIsZero || !outputValue || outputIsZero || !inputCurrency || !outputCurrency || isUnapproved) {
      isValid = false;
    }

    const { value: inputBalance, decimals: inputDecimals } = selectors().getBalance(account, inputCurrency);

    if (inputBalance.isLessThan(BN(inputValue * 10 ** inputDecimals))) {
      inputError = this.props.t("insufficientBalance");
    }

    if (inputValue === 'N/A') {
      inputError = this.props.t("inputNotValid");
    }

    return {
      extraFee,
      inputError,
      outputError,
      isValid: isValid && !inputError && !outputError,
    };
  }

  flipInputOutput = () => {
    const { state } = this;
    this.setState({
      inputValue: state.outputValue,
      outputValue: state.inputValue,
      inputCurrency: state.outputCurrency,
      outputCurrency: state.inputCurrency,
      lastEditedField: state.lastEditedField === INPUT ? OUTPUT : INPUT
    }, () => this.recalcForm());
  }

  isUnapproved() {
    const { account, exchangeAddresses, selectors } = this.props;
    const { inputCurrency, inputValue } = this.state;

    if (!inputCurrency || inputCurrency === 'VET') {
      return false;
    }

    const { value: allowance, label, decimals } = selectors().getApprovals(
      inputCurrency,
      account,
      exchangeAddresses.fromToken[inputCurrency]
    );

    if (label && allowance.isLessThan(BN(inputValue * 10 ** decimals || 0))) {
      return true;
    }

    return false;
  }

  recalcForm = () => {
    const { inputCurrency, outputCurrency, lastEditedField } = this.state;

    if (!inputCurrency || !outputCurrency) {
      return;
    }

    const editedValue = lastEditedField === INPUT ? this.state.inputValue : this.state.outputValue;

    if (BN(editedValue).isZero()) {
      return;
    }

    if (inputCurrency === outputCurrency) {
      this.setState({
        inputValue: '',
        outputValue: '',
      });
      return;
    }

    if (inputCurrency !== 'VET' && outputCurrency !== 'VET') {
      this.recalcTokenTokenForm();
      return;
    }

    this.recalcEthTokenForm();
  }

  recalcTokenTokenForm = async () => {
    const {
      exchangeAddresses: { fromToken },
      selectors,
      web3,
    } = this.props;

    const {
      inputValue: oldInputValue,
      outputValue: oldOutputValue,
      inputCurrency,
      outputCurrency,
      lastEditedField,
      exchangeRate: oldExchangeRate,
      inputAmountB: oldInputAmountB,      
    } = this.state;

    const exchangeAddressA = fromToken[inputCurrency];
    const exchangeAddressB = fromToken[outputCurrency];

    const exchangeA = new web3.eth.Contract(EXCHANGE_ABI, exchangeAddressA);
    const exchangeB = new web3.eth.Contract(EXCHANGE_ABI, exchangeAddressB);
    const exchangeFeeA = await exchangeA.methods.swap_fee().call();
    const exchangeFeeB = await exchangeB.methods.swap_fee().call();

    this.state.exchangeFee = (exchangeFeeA + exchangeFeeB) / 2; // Average rate, as function gets called twice

    const { value: inputReserveA, decimals: inputDecimalsA } = selectors().getBalance(exchangeAddressA, inputCurrency);
    const { value: outputReserveA }= selectors().getBalance(exchangeAddressA, 'VET');
    const { value: inputReserveB } = selectors().getBalance(exchangeAddressB, 'VET');
    const { value: outputReserveB, decimals: outputDecimalsB }= selectors().getBalance(exchangeAddressB, outputCurrency);

    if (lastEditedField === INPUT) {
      if (!oldInputValue) {
        return this.setState({
          outputValue: '',
          exchangeRate: BN(0),
        });
      }

      const inputAmountA = BN(oldInputValue).multipliedBy(10 ** inputDecimalsA);
      const outputAmountA = calculateEtherTokenOutput({
        inputAmount: inputAmountA,
        inputReserve: inputReserveA,
        outputReserve: outputReserveA,
      });
      // Redundant Variable for readability of the formala
      // OutputAmount from the first swap becomes InputAmount of the second swap
      const inputAmountB = outputAmountA;
      const outputAmountB = calculateEtherTokenOutput({
        inputAmount: inputAmountB,
        inputReserve: inputReserveB,
        outputReserve: outputReserveB,
      });

      const outputValue = outputAmountB.dividedBy(BN(10 ** outputDecimalsB)).toFixed(7);
      const exchangeRate = BN(outputValue).dividedBy(BN(oldInputValue));

      const appendState = {};

      if (!exchangeRate.isEqualTo(BN(oldExchangeRate))) {
        appendState.exchangeRate = exchangeRate;
      }

      if (outputValue !== oldOutputValue) {
        appendState.outputValue = outputValue;
      }

      this.setState(appendState);
    }

    if (lastEditedField === OUTPUT) {
      if (!oldOutputValue) {
        return this.setState({
          inputValue: '',
          exchangeRate: BN(0),
        });
      }

      const outputAmountB = BN(oldOutputValue).multipliedBy(10 ** outputDecimalsB);
      const inputAmountB = calculateEtherTokenInput({
        outputAmount: outputAmountB,
        inputReserve: inputReserveB,
        outputReserve: outputReserveB,
      });

      // Redundant Variable for readability of the formala
      // InputAmount from the first swap becomes OutputAmount of the second swap
      const outputAmountA = inputAmountB;
      const inputAmountA = calculateEtherTokenInput({
        outputAmount: outputAmountA,
        inputReserve: inputReserveA,
        outputReserve: outputReserveA,
      });

      const inputValue = inputAmountA.isNegative()
        ? 'N/A'
        : inputAmountA.dividedBy(BN(10 ** inputDecimalsA)).toFixed(7);
      const exchangeRate = BN(oldOutputValue).dividedBy(BN(inputValue));

      const appendState = {};

      if (!exchangeRate.isEqualTo(BN(oldExchangeRate))) {
        appendState.exchangeRate = exchangeRate;
      }

      if (inputValue !== oldInputValue) {
        appendState.inputValue = inputValue;
      }

      if (!inputAmountB.isEqualTo(BN(oldInputAmountB))) {
        appendState.inputAmountB = inputAmountB;
      }

      this.setState(appendState);
    }

  };

  recalcEthTokenForm = async () => {
    const {
      exchangeAddresses: { fromToken },
      selectors,
      web3
    } = this.props;

    const {
      inputValue: oldInputValue,
      outputValue: oldOutputValue,
      inputCurrency,
      outputCurrency,
      lastEditedField,
      exchangeRate: oldExchangeRate,
    } = this.state;

    const tokenAddress = [inputCurrency, outputCurrency].filter(currency => currency !== 'VET')[0];
    const exchangeAddress = fromToken[tokenAddress];
    if (!exchangeAddress) {
      return;
    }
    const { value: inputReserve, decimals: inputDecimals } = selectors().getBalance(exchangeAddress, inputCurrency);
    const { value: outputReserve, decimals: outputDecimals }= selectors().getBalance(exchangeAddress, outputCurrency);

    const exchange = new web3.eth.Contract(EXCHANGE_ABI, exchangeAddress);
    const exchangeFee = await exchange.methods.swap_fee().call();

    this.state.exchangeFee = exchangeFee;

    if (lastEditedField === INPUT) {
      if (!oldInputValue) {
        return this.setState({
          outputValue: '',
          exchangeRate: BN(0),
        });
      }

      const inputAmount = BN(oldInputValue).multipliedBy(10 ** inputDecimals);
      const outputAmount = calculateEtherTokenOutput({ inputAmount, inputReserve, outputReserve });
      const outputValue = outputAmount.dividedBy(BN(10 ** outputDecimals)).toFixed(7);
      const exchangeRate = BN(outputValue).dividedBy(BN(oldInputValue));

      const appendState = {};

      if (!exchangeRate.isEqualTo(BN(oldExchangeRate))) {
        appendState.exchangeRate = exchangeRate;
      }

      if (outputValue !== oldOutputValue) {
        appendState.outputValue = outputValue;
      }

      this.setState(appendState);
    } else if (lastEditedField === OUTPUT) {
      if (!oldOutputValue) {
        return this.setState({
          inputValue: '',
          exchangeRate: BN(0),
        });
      }

      const outputAmount = BN(oldOutputValue).multipliedBy(10 ** outputDecimals);
      const inputAmount = calculateEtherTokenInput({ outputAmount, inputReserve, outputReserve });
      const inputValue = inputAmount.isNegative()
        ? 'N/A'
        : inputAmount.dividedBy(BN(10 ** inputDecimals)).toFixed(7);
      const exchangeRate = BN(oldOutputValue).dividedBy(BN(inputValue));

      const appendState = {};

      if (!exchangeRate.isEqualTo(BN(oldExchangeRate))) {
        appendState.exchangeRate = exchangeRate;
      }

      if (inputValue !== oldInputValue) {
        appendState.inputValue = inputValue;
      }

      this.setState(appendState);
    }
  };

  updateInput = amount => {
    this.setState({
      inputValue: amount,
      lastEditedField: INPUT,
    }, this.recalcForm);
  };

  updateOutput = amount => {
    this.setState({
      outputValue: amount,
      lastEditedField: OUTPUT,
    }, this.recalcForm);
  };

  onSwap = async () => {
    const {
      exchangeAddresses: { fromToken },
      account,
      web3,
      selectors,
      addPendingTx,
      wallet,
      provider,
    } = this.props;
    const {
      inputValue,
      outputValue,
      inputCurrency,
      outputCurrency,
      inputAmountB,
      lastEditedField,
    } = this.state;
    const ALLOWED_SLIPPAGE = 0.025;
    const TOKEN_ALLOWED_SLIPPAGE = 0.04;

    const type = getSwapType(inputCurrency, outputCurrency);
    const { decimals: inputDecimals } = selectors().getBalance(account, inputCurrency);
    const { decimals: outputDecimals } = selectors().getBalance(account, outputCurrency);
    let deadline;
    try {
      deadline = await retry(() => getBlockDeadline(web3, 300));
    } catch(e) {
      // TODO: Handle error.
      return;
    }

    if (lastEditedField === INPUT) {
      // swap input
      ReactGA.event({
        category: type,
        action: 'SwapInput',
      });
      switch(type) {
        case 'ETH_TO_TOKEN':
          const { ethToTokenSwapInput } = new web3.eth.Contract(EXCHANGE_ABI, fromToken[outputCurrency]).methods;

          const ethToToken = ethToTokenSwapInput(
            BN(outputValue).multipliedBy(10 ** outputDecimals).multipliedBy(1 - ALLOWED_SLIPPAGE).toFixed(0),
            deadline,
          );

          if (provider === 'arkane') {
            const signer = window.arkaneConnect.createSigner();

            signer.executeNativeTransaction({
              type: 'VET_TRANSACTION',
               walletId: wallet.id,
              clauses: [{
                to: fromToken[outputCurrency],
                amount: BN(inputValue).multipliedBy(10 ** 18).toFixed(0),
                data: ethToToken.encodeABI(),
              }]
            }).then(({ result }) => {
              this.reset();
              addPendingTx(result.transactionHash);
            }).catch(reason => {
              console.log(reason);
            })

            return;
          }

          ethToToken.send({
            gas: await ethToToken.estimateGas({
              from: account,
              value: BN(inputValue).multipliedBy(10 ** 18).toFixed(0)
            }),
            from: account,
            value: BN(inputValue).multipliedBy(10 ** 18).toFixed(0)
          }, (err, data) => {
            if (!err) {
              addPendingTx(data);
              this.reset();
            }
          });
        break;
        case 'TOKEN_TO_ETH':
          const { tokenToEthSwapInput } = new web3.eth.Contract(EXCHANGE_ABI, fromToken[inputCurrency]).methods;

          const tokenToEth = tokenToEthSwapInput(
            BN(inputValue).multipliedBy(10 ** inputDecimals).toFixed(0),
            BN(outputValue).multipliedBy(10 ** outputDecimals).multipliedBy(1 - ALLOWED_SLIPPAGE).toFixed(0),
            deadline,
          );

          if (provider === 'arkane') {
            const signer = window.arkaneConnect.createSigner();

            signer.executeNativeTransaction({
              type: 'VET_TRANSACTION',
               walletId: wallet.id,
              clauses: [{
                amount: 0,
                to: fromToken[inputCurrency],
                data: tokenToEth.encodeABI(),
              }]
            }).then(({ result }) => {
              this.reset();
              addPendingTx(result.transactionHash);
            }).catch(reason => {
              console.log(reason);
            })

            return;
          }

          tokenToEth.send({
            gas: await tokenToEth.estimateGas({
              from: account,
            }),
            from: account, 
          }, (err, data) => {
            if (!err) {
              addPendingTx(data);
              this.reset();
            }
          });
        break;
        case 'TOKEN_TO_TOKEN':
          const { tokenToTokenSwapInput } = new web3.eth.Contract(EXCHANGE_ABI, fromToken[inputCurrency]).methods;

          const tokenToToken = tokenToTokenSwapInput(
            BN(inputValue).multipliedBy(10 ** inputDecimals).toFixed(0),
            BN(outputValue).multipliedBy(10 ** outputDecimals).multipliedBy(1 - TOKEN_ALLOWED_SLIPPAGE).toFixed(0),
            '1',
            deadline,
            outputCurrency,
          );

          if (provider === 'arkane') {
            const signer = window.arkaneConnect.createSigner();

            signer.executeNativeTransaction({
              type: 'VET_TRANSACTION',
               walletId: wallet.id,
              clauses: [{
                amount: 0,
                to: fromToken[inputCurrency],
                data: tokenToToken.encodeABI(),
              }]
            }).then(({ result }) => {
              this.reset();
              addPendingTx(result.transactionHash);
            }).catch(reason => {
              console.log(reason);
            })

            return;
          }

          tokenToToken.send({
            from: account,
            gas: await tokenToToken.estimateGas({ from: account }),
          }, (err, data) => {
            if (!err) {
              addPendingTx(data);
              this.reset();
            }
          });
          break;
        default:
          break;
      }
    }

    if (lastEditedField === OUTPUT) {
      // swap output
      ReactGA.event({
        category: type,
        action: 'SwapOutput',
      });
      switch (type) {
        case 'ETH_TO_TOKEN':
          const { ethToTokenSwapOutput } = new web3.eth.Contract(EXCHANGE_ABI, fromToken[outputCurrency]).methods;

          const ethToToken2 = ethToTokenSwapOutput(
            BN(outputValue).multipliedBy(10 ** outputDecimals).toFixed(0),
            deadline,
          );

          if (provider == 'arkane') {
            const signer = window.arkaneConnect.createSigner();

            signer.executeNativeTransaction({
              type: 'VET_TRANSACTION',
               walletId: wallet.id,
              clauses: [{
                to: fromToken[outputCurrency],
                amount: BN(inputValue).multipliedBy(10 ** inputDecimals).multipliedBy(1 + ALLOWED_SLIPPAGE).toFixed(0),
                data: ethToToken2.encodeABI(),
              }]
            }).then(({ result }) => {
              this.reset();
              addPendingTx(result.transactionHash);
            }).catch(reason => {
              console.log(reason);
            })

            return;
          }

          ethToToken2.send({
            gas: await ethToToken2.estimateGas({
              from: account,
              value: BN(inputValue).multipliedBy(10 ** inputDecimals).multipliedBy(1 + ALLOWED_SLIPPAGE).toFixed(0),
            }),
            from: account,
            value: BN(inputValue).multipliedBy(10 ** inputDecimals).multipliedBy(1 + ALLOWED_SLIPPAGE).toFixed(0),
          }, (err, data) => {
            if (!err) {
              addPendingTx(data);
              this.reset();
            }
          });
          break;
        case 'TOKEN_TO_ETH':
          const { tokenToEthSwapOutput } = new web3.eth.Contract(EXCHANGE_ABI, fromToken[inputCurrency]).methods;

          const tokenToEth = tokenToEthSwapOutput(
            BN(outputValue).multipliedBy(10 ** outputDecimals).toFixed(0),
            BN(inputValue).multipliedBy(10 ** inputDecimals).multipliedBy(1 + ALLOWED_SLIPPAGE).toFixed(0),
            deadline,
          );

          if (provider == 'arkane') {
            const signer = window.arkaneConnect.createSigner();

            signer.executeNativeTransaction({
              type: 'VET_TRANSACTION',
               walletId: wallet.id,
              clauses: [{
                amount: 0,
                to: fromToken[inputCurrency],
                data: tokenToEth.encodeABI(),
              }]
            }).then(({ result }) => {
              this.reset();
              addPendingTx(result.transactionHash);
            }).catch(reason => {
              console.log(reason);
            })

            return;
          }

          tokenToEth.send({
            gas: await tokenToEth.estimateGas({
              from: account,
            }),
            from: account,
          }, (err, data) => {
            if (!err) {
              addPendingTx(data);
              this.reset();
            }
          });
          break;
        case 'TOKEN_TO_TOKEN':
          if (!inputAmountB) {
            return;
          }

          const { tokenToTokenSwapOutput } = new web3.eth.Contract(EXCHANGE_ABI, fromToken[inputCurrency]).methods;

          const tokenToToken2 = tokenToTokenSwapOutput(
            BN(outputValue).multipliedBy(10 ** outputDecimals).toFixed(0),
            BN(inputValue).multipliedBy(10 ** inputDecimals).multipliedBy(1 + TOKEN_ALLOWED_SLIPPAGE).toFixed(0),
            inputAmountB.multipliedBy(1.2).toFixed(0),
            deadline,
            outputCurrency,
          );

          if (provider === 'arkane') {
            const signer = window.arkaneConnect.createSigner();

            signer.executeNativeTransaction({
              type: 'VET_TRANSACTION',
               walletId: wallet.id,
              clauses: [{
                amount: 0,
                to: fromToken[inputCurrency],
                data: tokenToToken2.encodeABI(),
              }]
            }).then(({ result }) => {
              this.reset();
              addPendingTx(result.transactionHash);
            }).catch(reason => {
              console.log(reason);
            })

            return;
          }

          tokenToToken2.send({
            gas: await tokenToEth.estimateGas({
              from: account,
            }),
            from: account,
          }, (err, data) => {
            if (!err) {
              addPendingTx(data);
              this.reset();
            }
          });

          break;
        default:
          break;
      }
    }
  };

  renderSummary(inputError, outputError) {
    const {
      inputValue,
      inputCurrency,
      outputValue,
      outputCurrency,
    } = this.state;
    const t = this.props.t;

    const inputIsZero = BN(inputValue).isZero();
    const outputIsZero = BN(outputValue).isZero();
    let contextualInfo = '';
    let isError = false;

    if (!inputCurrency || !outputCurrency) {
      contextualInfo = t("selectTokenCont");
    }

    if (!inputValue || !outputValue) {
      contextualInfo = t("enterValueCont");
    }

    if (inputError || outputError) {
      contextualInfo = inputError || outputError;
      isError = true;
    }

    if (inputIsZero || outputIsZero) {
      contextualInfo = t("noLiquidity");
    }

    if (this.isUnapproved()) {
      contextualInfo = t("unlockTokenCont");
    }

    return (
      <ContextualInfo
        openDetailsText={t("transactionDetails")}
        closeDetailsText={t("hideDetails")}
        contextualInfo={contextualInfo}
        isError={isError}
        renderTransactionDetails={this.renderTransactionDetails}
      />
    );
  }

  renderTransactionDetails = () => {
    const {
      inputValue,
      inputCurrency,
      outputValue,
      outputCurrency,
      lastEditedField,
    } = this.state;
    const { t, selectors, account } = this.props;
    ReactGA.event({
      category: 'TransactionDetail',
      action: 'Open',
    });
    const ALLOWED_SLIPPAGE = 0.025;
    const TOKEN_ALLOWED_SLIPPAGE = 0.04;

    const type = getSwapType(inputCurrency, outputCurrency);
    const { label: inputLabel, decimals: inputDecimals } = selectors().getBalance(account, inputCurrency);
    const { label: outputLabel, decimals: outputDecimals } = selectors().getBalance(account, outputCurrency);

    const label = lastEditedField === INPUT ? outputLabel : inputLabel;
    let minOutput;
    let maxInput;

    console.log(type)
    if (lastEditedField === INPUT) {
      switch(type) {
        case 'ETH_TO_TOKEN':
          minOutput = BN(outputValue).multipliedBy(1 - ALLOWED_SLIPPAGE).toFixed(7).trim();
          break;
        case 'TOKEN_TO_ETH':
          minOutput = BN(outputValue).multipliedBy(1 - ALLOWED_SLIPPAGE).toFixed(7);
          break;
        case 'TOKEN_TO_TOKEN':
          console.log('hit')
          minOutput = BN(outputValue).multipliedBy(1 - TOKEN_ALLOWED_SLIPPAGE).toFixed(7);
          break;
        default:
          break;
      }
    }

    if (lastEditedField === OUTPUT) {
      switch (type) {
        case 'ETH_TO_TOKEN':
          maxInput = BN(inputValue).multipliedBy(1 + ALLOWED_SLIPPAGE).toFixed(7).trim();
          break;
        case 'TOKEN_TO_ETH':
          maxInput = BN(inputValue).multipliedBy(1 + ALLOWED_SLIPPAGE).toFixed(7);
          break;
        case 'TOKEN_TO_TOKEN':
          console.log('hit 2')
          maxInput = BN(inputValue).multipliedBy(1 + TOKEN_ALLOWED_SLIPPAGE).toFixed(7);
          break;
        default:
          break;
      }
    }

    if (lastEditedField === INPUT) {
      return (
        <div>
          <div>
            {t("youAreSelling")} {b(`${+inputValue} ${inputLabel}`)} {t("orTransFail")}
          </div>
          <div className="send__last-summary-text">
            {t("youWillReceive")} {b(`${+minOutput} ${outputLabel}`)} {t("orTransFail")}
          </div>
        </div>
      );
    } else {
      return (
        <div>
          <div>
            {t("youAreBuying")} {b(`${+outputValue} ${outputLabel}`)}.
          </div>
          <div className="send__last-summary-text">
            {t("itWillCost")} {b(`${+maxInput} ${inputLabel}`)} {t("orTransFail")}
          </div>
        </div>
      );
    }
  }

  renderExchangeRate() {
    const { t, account, selectors } = this.props;
    const { exchangeRate, inputCurrency, outputCurrency } = this.state;
    const { label: inputLabel } = selectors().getBalance(account, inputCurrency);
    const { label: outputLabel } = selectors().getBalance(account, outputCurrency);

    if (!exchangeRate || exchangeRate.isNaN() || !inputCurrency || !outputCurrency) {
      return (
        <OversizedPanel hideBottom>
          <div className="swap__exchange-rate-wrapper">
            <span className="swap__exchange-rate">{t("exchangeRate")}</span>
            <span> - </span>
          </div>
        </OversizedPanel>
      );
    }

    return (
      <OversizedPanel hideBottom>
        <div className="swap__exchange-rate-wrapper">
          <span className="swap__exchange-rate">{t("exchangeRate")}</span>
          <span>
            {`1 ${inputLabel} = ${exchangeRate.toFixed(7)} ${outputLabel}`}
          </span>
        </div>
      </OversizedPanel>
    );
  }

  renderBalance(currency, balance, decimals) {
    if (!currency || decimals === 0) {
      return '';
    }

    const balanceInput = balance.dividedBy(BN(10 ** decimals)).toFixed(4)
    return this.props.t("balance", { balanceInput })
  }

  render() {
    const { t, selectors, account } = this.props;
    const {
      lastEditedField,
      inputCurrency,
      outputCurrency,
      inputValue,
      outputValue,
    } = this.state;
    const estimatedText = `(${t("estimated")})`;

    const { value: inputBalance, decimals: inputDecimals } = selectors().getBalance(account, inputCurrency);
    const { value: outputBalance, decimals: outputDecimals } = selectors().getBalance(account, outputCurrency);

    const { inputError, outputError, isValid, extraFee } = this.validate();

    let fee = '1%';

    if (extraFee) {
      fee = '2%';
    }

    return (
      <div className="swap">
        <MediaQuery query="(max-width: 767px)">
          <Header />
        </MediaQuery>
        <div
          className={classnames('swap__content', {
            'swap--inactive': !this.props.isConnected,
          })}
        >
          <NavigationTabs
            className={classnames('header__navigation', {
              'header--inactive': !this.props.isConnected,
            })}
          />
          <CurrencyInputPanel
            title={t("input")}
            description={lastEditedField === OUTPUT ? estimatedText : ''}
            extraText={this.renderBalance(inputCurrency, inputBalance, inputDecimals)}
            onCurrencySelected={inputCurrency => this.setState({ inputCurrency }, this.recalcForm)}
            onValueChange={this.updateInput}
            selectedTokens={[inputCurrency, outputCurrency]}
            selectedTokenAddress={inputCurrency}
            value={inputValue}
            errorMessage={inputError}
          />
          <OversizedPanel>
            <div className="swap__down-arrow-background">
              <img onClick={this.flipInputOutput} className="swap__down-arrow swap__down-arrow--clickable" src={isValid ? ArrowDownBlue : ArrowDownGrey} />
            </div>
          </OversizedPanel>
          <CurrencyInputPanel
            title={t("output")}
            description={lastEditedField === INPUT ? estimatedText : ''}
            extraText={this.renderBalance(outputCurrency, outputBalance, outputDecimals)}
            onCurrencySelected={outputCurrency => this.setState({ outputCurrency }, this.recalcForm)}
            onValueChange={this.updateOutput}
            selectedTokens={[inputCurrency, outputCurrency]}
            value={outputValue}
            selectedTokenAddress={outputCurrency}
            errorMessage={outputError}
            disableUnlock
          />
          { this.renderExchangeRate() }
          { this.renderSummary(inputError, outputError) }
          <div className="swap__cta-container">
            <button
              className={classnames('swap__cta-btn', {
                'swap--inactive': !this.props.isConnected,
              })}
              disabled={!isValid}
              onClick={this.onSwap}
            >
              {t("swap")}
            </button>
          </div>
          <div className="contextual-info__summary-wrapper">
            Exchange rate includes a {fee} swap fee
          </div>
        </div>
      </div>
    );
  }
}

export default connect(
  state => ({
    balances: state.web3connect.balances,
    isConnected: !!state.web3connect.account && state.web3connect.networkId == (process.env. REACT_APP_NETWORK_ID || 74),
    account: state.web3connect.account,
    exchangeAddresses: state.addresses.exchangeAddresses,
    web3: state.web3connect.web3,
    provider: state.web3connect.provider,
    wallet: state.web3connect.wallet,
  }),
  dispatch => ({
    selectors: () => dispatch(selectors()),
    addPendingTx: id => dispatch(addPendingTx(id)),
  }),
)(withNamespaces()(Swap));

const b = text => <span className="swap__highlight-text">{text}</span>;

function calculateEtherTokenOutput({ inputAmount: rawInput, inputReserve: rawReserveIn, outputReserve: rawReserveOut }) {
  const inputAmount = BN(rawInput);
  const inputReserve = BN(rawReserveIn);
  const outputReserve = BN(rawReserveOut);

  if (inputAmount.isLessThan(BN(10 ** 9))) {
    console.warn(`inputAmount is only ${inputAmount.toFixed(0)}. Did you forget to multiply by 10 ** decimals?`);
  }

  const numerator = inputAmount.multipliedBy(outputReserve).multipliedBy(10000 - this.state.exchangeFee);
  const denominator = inputReserve.multipliedBy(10000).plus(inputAmount.multipliedBy(10000 - this.state.exchangeFee));

  return numerator.dividedBy(denominator);
}

function calculateEtherTokenInput({ outputAmount: rawOutput, inputReserve: rawReserveIn, outputReserve: rawReserveOut }) {
  const outputAmount = BN(rawOutput);
  const inputReserve = BN(rawReserveIn);
  const outputReserve = BN(rawReserveOut);

  if (outputAmount.isLessThan(BN(10 ** 9))) {
    console.warn(`inputAmount is only ${outputAmount.toFixed(0)}. Did you forget to multiply by 10 ** decimals?`);
  }

  const numerator = outputAmount.multipliedBy(inputReserve).multipliedBy(10000);
  const denominator = outputReserve.minus(outputAmount).multipliedBy(10000 - this.state.exchangeFee);
  return (numerator.dividedBy(denominator)).plus(1);
}

function getSwapType(inputCurrency, outputCurrency) {
  if (!inputCurrency || !outputCurrency) {
    return;
  }

  if (inputCurrency === outputCurrency) {
    return;
  }

  if (inputCurrency !== 'VET' && outputCurrency !== 'VET') {
    console.log('l')
    return 'TOKEN_TO_TOKEN'
  }

  if (inputCurrency === 'VET') {
    return 'ETH_TO_TOKEN';
  }

  if (outputCurrency === 'VET') {
    return 'TOKEN_TO_ETH';
  }

  return;
}
