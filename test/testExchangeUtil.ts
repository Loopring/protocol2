import { BigNumber } from "bignumber.js";
import BN = require("bn.js");
import fs = require("fs");
import * as pjs from "protocol2-js";
import util = require("util");
import { Artifacts } from "../util/Artifacts";
import { FeePayments } from "./feePayments";
import { ringsInfoList } from "./rings_config";
import { ExchangeTestContext } from "./testExchangeContext";

export class ExchangeTestUtil {
  public context: pjs.Context;
  public testContext: ExchangeTestContext;
  public ringSubmitter: any;

  public async initialize(accounts: string[]) {
    this.context = await this.createContractContext();
    this.testContext = await this.createExchangeTestContext(accounts);
    await this.initializeTradeDelegate();
  }

  public assertNumberEqualsWithPrecision(n1: number, n2: number, precision: number = 8) {
    const numStr1 = (n1 / 1e18).toFixed(precision);
    const numStr2 = (n2 / 1e18).toFixed(precision);

    return assert.equal(Number(numStr1), Number(numStr2));
  }

  public async getEventsFromContract(contract: any, eventName: string, fromBlock: number) {
    return new Promise((resolve, reject) => {
      if (!contract[eventName]) {
        throw Error("TypeError: contract[eventName] is not a function: " + eventName);
      }

      const events = contract[eventName]({}, { fromBlock, toBlock: "latest" });
      events.watch();
      events.get((error: any, event: any) => {
        if (!error) {
          resolve(event);
        } else {
          throw Error("Failed to find filtered event: " + error);
        }
      });
      events.stopWatching();
    });
  }

  public async getTransferEvents(tokensERC20: any[], tokensERC1400: any[], fromBlock: number) {
    const transferItems: pjs.TransferItem[] = [];
    const zeroAddress = "0x" + "0".repeat(64);
    // ERC20
    for (const tokenContractInstance of tokensERC20) {
      const eventArr: any = await this.getEventsFromContract(tokenContractInstance, "Transfer", fromBlock);
      eventArr.map((eventObj: any) => {
        const transferItem: pjs.TransferItem = {
          token: tokenContractInstance.address,
          from: eventObj.args.from,
          to: eventObj.args.to,
          amount: eventObj.args.value,
          tokenType: pjs.TokenType.ERC20,
          fromTranche: zeroAddress,
          toTranche: zeroAddress,
        };
        // console.log(transferItem);
        transferItems.push(transferItem);
      });

    }
    // ERC1400
    for (const tokenContractInstance of tokensERC1400) {
      const eventArr: any = await this.getEventsFromContract(tokenContractInstance, "SentTranche", fromBlock);
      eventArr.map((eventObj: any) => {
        const transferItem: pjs.TransferItem = {
          token: tokenContractInstance.address,
          from: eventObj.args.from,
          to: eventObj.args.to,
          amount: eventObj.args.amount,
          tokenType: pjs.TokenType.ERC1400,
          fromTranche: eventObj.args.fromTranche,
          toTranche: eventObj.args.toTranche,
          data: eventObj.args.data,
        };
        // console.log(transferItem);
        transferItems.push(transferItem);
      });
    }

    return transferItems;
  }

  public async getRingMinedEvents(fromBlock: number) {
    const parseFillsData = (data: string) => {
      const b = new pjs.Bitstream(data);
      const fillSize = 8 * 32;
      const numFills = b.length() / fillSize;
      const fills: pjs.Fill[] = [];
      for (let offset = 0; offset < b.length(); offset += fillSize) {
        const fill: pjs.Fill = {
          orderHash: "0x" + b.extractBytes32(offset).toString("hex"),
          owner: "0x" + b.extractBytes32(offset + 32).toString("hex").slice(24),
          tokenS: "0x" + b.extractBytes32(offset + 64).toString("hex").slice(24),
          amountS: b.extractUint(offset + 96),
          split: b.extractUint(offset + 128),
          feeAmount: b.extractUint(offset + 160),
          feeAmountS: b.extractUint(offset + 192),
          feeAmountB: b.extractUint(offset + 224),
        };
        fills.push(fill);
      }
      return fills;
    };
    const eventArr: any = await this.getEventsFromContract(this.ringSubmitter, "RingMined", fromBlock);
    const ringMinedEvents = eventArr.map((eventObj: any) => {
      const ringMinedEvent: pjs.RingMinedEvent = {
        ringIndex: eventObj.args._ringIndex,
        ringHash: eventObj.args._ringHash,
        feeRecipient: eventObj.args._feeRecipient,
        fills: parseFillsData(eventObj.args._fills),
      };
      return ringMinedEvent;
    });
    return ringMinedEvents;
  }

  public async getInvalidRingEvents(fromBlock: number) {
    const eventArr: any = await this.getEventsFromContract(this.ringSubmitter, "InvalidRing", fromBlock);
    const invalidRingEvents = eventArr.map((eventObj: any) => {
      const invalidRingEvent: pjs.InvalidRingEvent = {
        ringHash: eventObj.args._ringHash,
      };
      return invalidRingEvent;
    });
    return invalidRingEvents;
  }

  public async watchAndPrintEvent(contract: any, eventName: string) {
    const events: any = await this.getEventsFromContract(contract, eventName, 0);

    events.forEach((e: any) => {
      pjs.logDebug("event:", util.inspect(e.args, false, null));
    });
  }

  public logDetailedTokenTransfer(addressBook: { [id: string]: string; },
                                  payment: pjs.DetailedTokenTransfer,
                                  depth: number = 0) {
    if (payment.amount === 0 && payment.subPayments.length === 0) {
      return;
    }
    const tokenSymbol = this.testContext.tokenAddrSymbolMap.get(payment.token);
    const whiteSpace = " ".repeat(depth);
    const description = payment.description ? payment.description : "";
    const amount = (payment.amount / 1e18);
    if (payment.subPayments.length === 0) {
      const toName =  addressBook[payment.to];
      pjs.logDebug(whiteSpace + "- " + " [" + description + "] " + amount + " " + tokenSymbol + " -> " + toName);
    } else {
      pjs.logDebug(whiteSpace + "+ " + " [" + description + "] " + amount + " " + tokenSymbol);
      for (const subPayment of payment.subPayments) {
        this.logDetailedTokenTransfer(addressBook, subPayment, depth + 1);
      }
    }
  }

  public logDetailedTokenTransfers(ringsInfo: pjs.RingsInfo, report: pjs.SimulatorReport) {
    const addressBook = this.getAddressBook(ringsInfo);
    for (const [r, ring] of report.payments.rings.entries()) {
      pjs.logDebug("# Payments for ring " + r + ": ");
      for (const [o, order] of ring.orders.entries()) {
        pjs.logDebug("## Order " + o + ": ");
        for (const payment of order.payments) {
          this.logDetailedTokenTransfer(addressBook, payment, 1);
        }
      }
    }
  }

  public async setupRings(ringsInfo: pjs.RingsInfo) {
    if (ringsInfo.transactionOrigin === undefined) {
      ringsInfo.transactionOrigin = this.testContext.transactionOrigin;
      ringsInfo.feeRecipient = this.testContext.feeRecipient;
      ringsInfo.miner = this.testContext.miner;
    } else {
      if (!ringsInfo.transactionOrigin.startsWith("0x")) {
        const accountIndex = parseInt(ringsInfo.transactionOrigin, 10);
        assert(accountIndex >= 0 && accountIndex < this.testContext.orderOwners.length, "Invalid owner index");
        ringsInfo.transactionOrigin = this.testContext.orderOwners[accountIndex];
        ringsInfo.feeRecipient = undefined;
        ringsInfo.miner = undefined;
      }
    }
    for (const [i, order] of ringsInfo.orders.entries()) {
      await this.setupOrder(order, i);
    }
  }

  public async setupOrder(order: pjs.OrderInfo, index: number) {
    if (order.owner === undefined) {
      const accountIndex = index % this.testContext.orderOwners.length;
      order.owner = this.testContext.orderOwners[accountIndex];
    } else if (order.owner !== undefined && !order.owner.startsWith("0x")) {
      const accountIndex = parseInt(order.owner, 10);
      assert(accountIndex >= 0 && accountIndex < this.testContext.orderOwners.length, "Invalid owner index");
      order.owner = this.testContext.orderOwners[accountIndex];
    }
    if (!order.tokenS.startsWith("0x")) {
      order.tokenS = this.testContext.tokenSymbolAddrMap.get(order.tokenS);
    }
    if (!order.tokenB.startsWith("0x")) {
      order.tokenB = this.testContext.tokenSymbolAddrMap.get(order.tokenB);
    }
    if (order.feeToken && !order.feeToken.startsWith("0x")) {
      order.feeToken = this.testContext.tokenSymbolAddrMap.get(order.feeToken);
    }
    if (order.feeAmount === undefined) {
      order.feeAmount = 1e18;
    }
    if (!order.dualAuthSignAlgorithm) {
      order.dualAuthSignAlgorithm = pjs.SignAlgorithm.Ethereum;
    }
    // no dualAuthAddr for onChain order
    if (!order.onChain && order.dualAuthAddr && !order.dualAuthAddr.startsWith("0x")) {
      const dualAuthorIndex = parseInt(order.dualAuthAddr, 10);
      assert(dualAuthorIndex >= 0 && dualAuthorIndex < this.testContext.orderDualAuthAddrs.length,
             "Invalid dual author index");
      order.dualAuthAddr = this.testContext.orderDualAuthAddrs[dualAuthorIndex];
    }
    if (!order.onChain &&
        order.dualAuthAddr === undefined &&
        order.dualAuthSignAlgorithm !== pjs.SignAlgorithm.None) {
      const accountIndex = index % this.testContext.orderDualAuthAddrs.length;
      order.dualAuthAddr = this.testContext.orderDualAuthAddrs[accountIndex];
    }
    if (!order.allOrNone) {
      order.allOrNone = false;
    }
    if (!order.validSince) {
      // Set the order validSince time to a bit before the current timestamp;
      order.validSince = web3.eth.getBlock(web3.eth.blockNumber).timestamp - 1000;
    }
    if (!order.validUntil && (order.index % 2) === 1) {
      // Set the order validUntil time to a bit after the current timestamp;
      order.validUntil = web3.eth.getBlock(web3.eth.blockNumber).timestamp + 2500;
    }

    if (order.walletAddr && !order.walletAddr.startsWith("0x")) {
      const walletIndex = parseInt(order.walletAddr, 10);
      assert(walletIndex >= 0 && walletIndex < this.testContext.wallets.length,
             "Invalid wallet index");
      order.walletAddr = this.testContext.wallets[walletIndex];
    }
    if (order.walletAddr === undefined) {
      order.walletAddr = this.testContext.wallets[0];
    }
    if (order.walletAddr && order.walletSplitPercentage === undefined) {
      order.walletSplitPercentage = ((index + 1) * 10) % 100;
    }
    if (order.tokenRecipient !== undefined && !order.tokenRecipient.startsWith("0x")) {
      const accountIndex = parseInt(order.tokenRecipient, 10);
      assert(accountIndex >= 0 && accountIndex < this.testContext.allOrderTokenRecipients.length,
             "Invalid token recipient index");
      order.tokenRecipient = this.testContext.allOrderTokenRecipients[accountIndex];
    }
    if (order.signAlgorithm === undefined) {
      const signAlgorithmIndex = index % 2;
      order.signAlgorithm = (signAlgorithmIndex === 0) ? pjs.SignAlgorithm.Ethereum : pjs.SignAlgorithm.EIP712;
    }
    if (order.signAlgorithm === pjs.SignAlgorithm.EIP712) {
      order.signerPrivateKey = this.getPrivateKey(order.broker ? order.broker : order.owner);
    }
    // Fill in defaults (default, so these will not get serialized)
    order.version = 0;
    order.validUntil = order.validUntil ? order.validUntil : 0;
    order.tokenRecipient = order.tokenRecipient ? order.tokenRecipient : order.owner;
    order.feeToken = order.feeToken ? order.feeToken : this.context.lrcAddress;
    order.feeAmount = order.feeAmount ? order.feeAmount : 0;
    order.waiveFeePercentage = order.waiveFeePercentage ? order.waiveFeePercentage : 0;
    order.tokenSFeePercentage = order.tokenSFeePercentage ? order.tokenSFeePercentage : 0;
    order.tokenBFeePercentage = order.tokenBFeePercentage ? order.tokenBFeePercentage : 0;
    order.walletSplitPercentage = order.walletSplitPercentage ? order.walletSplitPercentage : 0;
    order.tokenTypeS = order.tokenTypeS ? order.tokenTypeS : pjs.TokenType.ERC20;
    order.tokenTypeB = order.tokenTypeB ? order.tokenTypeB : pjs.TokenType.ERC20;
    order.tokenTypeFee = order.tokenTypeFee ? order.tokenTypeFee : pjs.TokenType.ERC20;
    order.trancheS = order.trancheS ? order.trancheS : "0x" + "0".repeat(64);
    order.trancheB = order.trancheB ? order.trancheB : "0x" + "0".repeat(64);
    order.transferDataS = order.transferDataS ? order.transferDataS : "0x";

    // setup initial balances:
    await this.setOrderBalances(order);
  }

  public async setBalance(tokenType: pjs.TokenType, token: any, owner: string, tranche: string, amount: number) {
    switch (tokenType) {
      case pjs.TokenType.ERC20:
        await token.setBalance(owner, amount);
        break;
      case pjs.TokenType.ERC1400:
        await token.setBalance(owner, tranche, amount);
        break;
      default:
        assert(false, "Unknown token type: " + tokenType);
    }
  }

  public async addBalance(tokenType: pjs.TokenType, token: any, owner: string, tranche: string, amount: number) {
    switch (tokenType) {
      case pjs.TokenType.ERC20:
        await token.addBalance(owner, amount);
        break;
      case pjs.TokenType.ERC1400:
        await token.addBalance(owner, tranche, amount);
        break;
      default:
        assert(false, "Unknown token type: " + tokenType);
    }
  }

  public async setOrderBalances(order: pjs.OrderInfo) {
    const tokenS = this.testContext.tokenAddrInstanceMap.get(order.tokenS);
    const balanceS = (order.balanceS !== undefined) ? order.balanceS : order.amountS;
    await this.setBalance(order.tokenTypeS, tokenS, order.owner, order.trancheS, balanceS);

    const feeToken = order.feeToken ? order.feeToken : this.context.lrcAddress;
    const balanceFee = (order.balanceFee !== undefined) ? order.balanceFee : order.feeAmount;
    if (feeToken === order.tokenS) {
      await this.addBalance(order.tokenTypeFee, tokenS, order.owner, order.trancheS, balanceFee);
    } else {
      const tokenFee = this.testContext.tokenAddrInstanceMap.get(feeToken);
      await this.setBalance(order.tokenTypeFee, tokenFee, order.owner, "0x0", balanceFee);
    }

    if (order.balanceB) {
      const tokenB = this.testContext.tokenAddrInstanceMap.get(order.tokenB);
      await this.setBalance(order.tokenTypeB, tokenB, order.owner, order.trancheB, order.balanceB);
    }
  }

  public async getFilled(hash: Buffer) {
    return await this.context.tradeDelegate.filled("0x" + hash.toString("hex")).toNumber();
  }

  public async checkFilled(hash: Buffer, expected: number) {
    const filled = await this.getFilled(hash);
    this.assertNumberEqualsWithPrecision(filled, expected);
  }

  public assertEqualsRingsInfo(ringsInfoA: pjs.RingsInfo, ringsInfoB: pjs.RingsInfo) {
    // Revert defaults back to undefined
    ringsInfoA.miner = (ringsInfoA.miner === ringsInfoA.feeRecipient) ? undefined : ringsInfoA.miner;
    ringsInfoB.miner = (ringsInfoB.miner === ringsInfoB.feeRecipient) ? undefined : ringsInfoB.miner;

    // Blacklist properties we don't want to check.
    // We don't whitelist because we might forget to add them here otherwise.
    const ringsInfoPropertiesToSkip = ["description", "signAlgorithm", "hash", "expected"];
    const orderPropertiesToSkip = [
      "maxAmountS", "fillAmountS", "fillAmountB", "fillAmountFee", "splitS", "brokerInterceptor",
      "valid", "hash", "delegateContract", "signAlgorithm", "dualAuthSignAlgorithm", "index", "lrcAddress",
      "balanceS", "balanceFee", "tokenSpendableS", "tokenSpendableFee",
      "brokerSpendableS", "brokerSpendableFee", "onChain", "balanceB", "signerPrivateKey",
    ];
    // Make sure to get the keys from both objects to make sure we get all keys defined in both
    for (const key of [...Object.keys(ringsInfoA), ...Object.keys(ringsInfoB)]) {
      if (ringsInfoPropertiesToSkip.every((x) => x !== key)) {
        if (key === "rings") {
          assert.equal(ringsInfoA.rings.length, ringsInfoB.rings.length,
                       "Number of rings does not match");
          for (let r = 0; r < ringsInfoA.rings.length; r++) {
            assert.equal(ringsInfoA.rings[r].length, ringsInfoB.rings[r].length,
                         "Number of orders in rings does not match");
            for (let o = 0; o < ringsInfoA.rings[r].length; o++) {
              assert.equal(ringsInfoA.rings[r][o], ringsInfoB.rings[r][o],
                           "Order indices in rings do not match");
            }
          }
        } else if (key === "orders") {
          assert.equal(ringsInfoA.orders.length, ringsInfoB.orders.length,
                       "Number of orders does not match");
          for (let o = 0; o < ringsInfoA.orders.length; o++) {
            for (const orderKey of [...Object.keys(ringsInfoA.orders[o]), ...Object.keys(ringsInfoB.orders[o])]) {
              if (orderPropertiesToSkip.every((x) => x !== orderKey)) {
                assert.equal(ringsInfoA.orders[o][orderKey], ringsInfoB.orders[o][orderKey],
                             "Order property '" + orderKey + "' does not match");
              }
            }
          }
        } else {
            assert.equal(ringsInfoA[key], ringsInfoB[key],
                         "RingInfo property '" + key + "' does not match");
        }
      }
    }
  }

  public getAddressBook(ringsInfo: pjs.RingsInfo) {
    const addAddress = (addrBook: { [id: string]: any; }, address: string, name: string) => {
      addrBook[address] = (addrBook[address] ? addrBook[address] + "=" : "") + name;
    };

    const addressBook: { [id: string]: string; } = {};
    const feeRecipient = ringsInfo.feeRecipient ? ringsInfo.feeRecipient  : ringsInfo.transactionOrigin;
    const miner = ringsInfo.miner ? ringsInfo.miner : feeRecipient;
    addAddress(addressBook, ringsInfo.transactionOrigin, "Tx.origin");
    addAddress(addressBook, miner, "Miner");
    addAddress(addressBook, feeRecipient, "FeeRecipient");
    addAddress(addressBook, this.context.feeHolder.address, "FeeHolder");
    for (const [i, order] of ringsInfo.orders.entries()) {
      addAddress(addressBook, order.owner, "Owner[" + i + "]");
      if (order.owner !== order.tokenRecipient) {
        addAddress(addressBook, order.tokenRecipient, "TokenRecipient[" + i + "]");
      }
      addAddress(addressBook, order.walletAddr, "Wallet[" + i + "]");
      if (order.hash) {
        addAddress(addressBook, order.hash.toString("hex"), "Hash[" + i + "]");
      }
    }
    return addressBook;
  }

  public assertTransfers(ringsInfo: pjs.RingsInfo,
                         tranferEvents: pjs.TransferItem[],
                         transferList: pjs.TransferItem[]) {
    const sorter = (a: pjs.TransferItem, b: pjs.TransferItem) => {
      if (a.token === b.token) {
        if (a.from === b.from) {
          if (a.to === b.to) {
            return a.amount.minus(b.amount).toNumber();
          } else {
            return a.to > b.to ? 1 : -1;
          }
        } else {
          return a.from > b.from ? 1 : -1;
        }
      } else {
        return a.token > b.token ? 1 : -1;
      }
    };

    transferList.sort(sorter);
    tranferEvents.sort(sorter);
    const addressBook = this.getAddressBook(ringsInfo);
    pjs.logDebug("transfer items from simulator:");
    transferList.forEach((t) => {
      const tokenSymbol = this.testContext.tokenAddrSymbolMap.get(t.token);
      const fromName = addressBook[t.from];
      const toName = addressBook[t.to];
      pjs.logDebug(fromName + " -> " + toName + " : " + t.amount.toNumber() / 1e18 + " " + tokenSymbol);
    });
    pjs.logDebug("transfer items from contract:");
    tranferEvents.forEach((t) => {
      const tokenSymbol = this.testContext.tokenAddrSymbolMap.get(t.token);
      const fromName = addressBook[t.from];
      const toName = addressBook[t.to];
      pjs.logDebug(fromName + " -> " + toName + " : " + t.amount.toNumber() / 1e18 + " " + tokenSymbol);
    });
    assert.equal(tranferEvents.length, transferList.length, "Number of transfers do not match");
    for (let i = 0; i < tranferEvents.length; i++) {
      const transferFromEvent = tranferEvents[i];
      const transferFromSimulator = transferList[i];
      assert.equal(transferFromEvent.token, transferFromSimulator.token, "Token mismatch");
      assert.equal(transferFromEvent.from, transferFromSimulator.from, "From mismatch");
      assert.equal(transferFromEvent.to, transferFromSimulator.to, "To mismatch");
      assert(transferFromEvent.amount.eq(transferFromSimulator.amount), "Transfer amount does not match");
      assert.equal(transferFromEvent.fromTranche, transferFromSimulator.fromTranche, "FromTranche mismatch");
      assert.equal(transferFromEvent.toTranche, transferFromSimulator.toTranche, "toTranche mismatch");
      assert.equal(transferFromEvent.data, transferFromSimulator.data, "data mismatch");
    }
  }

  public assertRingMinedEvents(ringMinedEventsContract: pjs.RingMinedEvent[],
                               ringMinedEventsSimulator: pjs.RingMinedEvent[]) {
    assert.equal(ringMinedEventsContract.length, ringMinedEventsSimulator.length,
                 "Number of RingMined events does not match");
    for (let i = 0; i < ringMinedEventsContract.length; i++) {
      const contractEvent = ringMinedEventsContract[i];
      const simulatorEvent = ringMinedEventsSimulator[i];
      assert(contractEvent.ringIndex.eq(simulatorEvent.ringIndex), "ringIndex does not match");
      assert.equal(contractEvent.ringHash, simulatorEvent.ringHash, "ringHash does not match");
      assert.equal(contractEvent.feeRecipient, simulatorEvent.feeRecipient, "feeRecipient does not match");
      assert.equal(contractEvent.fills.length, simulatorEvent.fills.length, "fills length does not match");
      for (let f = 0; f < contractEvent.fills.length; f++) {
        const contractFill = contractEvent.fills[f];
        const simulatorFill = simulatorEvent.fills[f];
        assert.equal(contractFill.orderHash, simulatorFill.orderHash, "orderHash does not match");
        assert.equal(contractFill.owner, simulatorFill.owner, "owner does not match");
        assert.equal(contractFill.tokenS, simulatorFill.tokenS, "tokenS does not match");
        assert(contractFill.amountS.eq(simulatorFill.amountS), "amountS does not match");
        assert(contractFill.split.eq(simulatorFill.split), "split does not match");
        assert(contractFill.feeAmount.eq(simulatorFill.feeAmount), "feeAmount does not match");
        assert(contractFill.feeAmountS.eq(simulatorFill.feeAmountS), "feeAmountS does not match");
        assert(contractFill.feeAmountB.eq(simulatorFill.feeAmountB), "feeAmountB does not match");
      }
    }
  }

  public assertInvalidRingEvents(invalidRingEventsContract: pjs.InvalidRingEvent[],
                                 invalidRingEventsSimulator: pjs.InvalidRingEvent[]) {
    assert.equal(invalidRingEventsContract.length, invalidRingEventsSimulator.length,
                 "Number of InvalidRing events does not match");
    for (let i = 0; i < invalidRingEventsContract.length; i++) {
      const contractEvent = invalidRingEventsContract[i];
      const simulatorEvent = invalidRingEventsSimulator[i];
      assert.equal(contractEvent.ringHash, simulatorEvent.ringHash, "ringHash does not match");
    }
  }

  public async assertFeeBalances(ringsInfo: pjs.RingsInfo,
                                 feeBalancesBefore: pjs.BalanceBook,
                                 feeBalancesAfter: pjs.BalanceBook) {
    const addressBook = this.getAddressBook(ringsInfo);
    pjs.logDebug("Fee balances:");
    for (const balance of feeBalancesAfter.getAllBalances()) {
      const balanceBefore = feeBalancesBefore.getBalance(balance.owner, balance.token, balance.tranche);
      const balanceFromSimulator = feeBalancesAfter.getBalance(balance.owner, balance.token, balance.tranche);
      const balanceFromContract = await this.context.feeHolder.feeBalances(balance.token, balance.owner);
      if (!balanceBefore.eq(balanceFromSimulator)) {
        const ownerName = addressBook[balance.owner] ? addressBook[balance.owner] : balance.owner;
        const tokenSymbol = this.testContext.tokenAddrSymbolMap.get(balance.token);
        pjs.logDebug(ownerName + ": " +
                     balanceFromContract  / 1e18 + " " + tokenSymbol + " " +
                     "(Simulator: " + balanceFromSimulator  / 1e18 + ")");
      }
      assert(balanceFromContract.eq(balanceFromSimulator));
    }
  }

  public async assertFilledAmounts(ringsInfo: pjs.RingsInfo,
                                   filledAmounts: { [hash: string]: BigNumber; }) {
    const addressBook = this.getAddressBook(ringsInfo);
    pjs.logDebug("Filled amounts:");
    for (const hash of Object.keys(filledAmounts)) {
      let hashOrder: pjs.OrderInfo = null;
      for (const order of ringsInfo.orders) {
        if (order.hash.toString("hex") === hash) {
          hashOrder = order;
        }
      }
      const filledFromSimulator = filledAmounts[hash];
      const filledFromContract = await this.context.tradeDelegate.filled("0x" + hash);
      let percentageFilled = 0;
      if (hashOrder) {
        percentageFilled = filledFromContract.toNumber() * 100 / hashOrder.amountS;
      }
      const hashName = addressBook[hash];
      pjs.logDebug(hashName + ": " + filledFromContract.toNumber() / 1e18 +
                  " (Simulator: " + filledFromSimulator.toNumber() / 1e18 + ")" +
                  " (" + percentageFilled + "%)");
      assert(filledFromContract.eq(filledFromSimulator));
    }
  }

  public async assertOrdersValid(orders: pjs.OrderInfo[], expectedValidValues: boolean[]) {
    assert.equal(orders.length, expectedValidValues.length, "Array sizes need to match");

    const bitstream = new pjs.Bitstream();
    for (const order of orders) {
      const broker = order.broker ? order.broker : order.owner;
      bitstream.addAddress(broker, 32);
      bitstream.addAddress(order.owner, 32);
      bitstream.addHex(order.hash.toString("hex"));
      bitstream.addNumber(order.validSince, 32);
      bitstream.addHex(pjs.xor(order.tokenS, order.tokenB, 20).slice(2));
      bitstream.addNumber(0, 12);
    }

    const fills = await this.context.tradeDelegate.batchGetFilledAndCheckCancelled(bitstream.getBytes32Array());

    const cancelledValue = new BigNumber("F".repeat(64), 16);
    for (const [i, order] of orders.entries()) {
        assert.equal(!fills[i].equals(cancelledValue), expectedValidValues[i], "Order cancelled status incorrect");
    }
  }

  public async registerOrderBrokerChecked(user: string, broker: string, interceptor: string) {
    const {
      BrokerRegistry,
    } = new Artifacts(artifacts);
    const brokerRegistry = BrokerRegistry.at(this.context.orderBrokerRegistry.address);
    await brokerRegistry.registerBroker(broker, interceptor, {from: user});
    await this.assertOrderBrokerRegistered(user, broker, interceptor);
  }

  public async unregisterOrderBrokerChecked(user: string, broker: string) {
    const {
      BrokerRegistry,
    } = new Artifacts(artifacts);
    const brokerRegistry = BrokerRegistry.at(this.context.orderBrokerRegistry.address);
    await brokerRegistry.unregisterBroker(broker, {from: user});
    await this.assertOrderBrokerNotRegistered(user, broker);
  }

  public async assertOrderBrokerRegistered(user: string, broker: string, interceptor: string) {
    const {
      BrokerRegistry,
    } = new Artifacts(artifacts);
    const brokerRegistry = BrokerRegistry.at(this.context.orderBrokerRegistry.address);
    const [isRegistered, interceptorFromContract] = await brokerRegistry.getBroker(user, broker);
    assert(isRegistered, "interceptor should be registered.");
    assert.equal(interceptor, interceptorFromContract, "get wrong interceptor");
  }

  public async assertOrderBrokerNotRegistered(user: string, broker: string) {
    const {
      BrokerRegistry,
    } = new Artifacts(artifacts);
    const brokerRegistry = BrokerRegistry.at(this.context.orderBrokerRegistry.address);
    const [isRegistered, interceptorFromContract] = await brokerRegistry.getBroker(user, broker);
    assert(!isRegistered, "interceptor should not be registered.");
  }

  public async deserializeRing(ringsInfo: pjs.RingsInfo) {
    const ringsGenerator = new pjs.RingsGenerator(this.context);
    await ringsGenerator.setupRingsAsync(ringsInfo);
    const bs = ringsGenerator.toSubmitableParam(ringsInfo);
    return bs;
  }

  public async submitRingsAndSimulate(ringsInfo: pjs.RingsInfo,
                                      dummyExchange?: any,
                                      submitter?: any) {
    if (dummyExchange !== undefined) {
      const {
        DummyToken,
      } = new Artifacts(artifacts);
      // Add an initial fee payment to all addresses to make gas use more realistic
      // (gas cost to change variable in storage: zero -> non-zero: 20,000 gas, non-zero -> non-zero: 5,000 gas)
      // Addresses getting fees will be getting a lot of fees so a balance of 0 is not realistic
      const minerFeeRecipient = ringsInfo.feeRecipient ? ringsInfo.feeRecipient : ringsInfo.transactionOrigin;
      const feePayments = new FeePayments();
      for (const order of ringsInfo.orders) {
        // All tokens that could be paid to all recipients for this order
        const tokens = [order.feeToken, order.tokenS, order.tokenB];
        const feeRecipients = [order.owner, minerFeeRecipient, this.context.feeHolder.address, order.walletAddr];
        for (const token of tokens) {
          for (const feeRecipient of feeRecipients) {
            if (feeRecipient) {
              feePayments.add(feeRecipient, token, 1);
            }
          }
        }
        // Add balances to the feeHolder contract
        for (const token of tokens) {
          const Token = this.testContext.tokenAddrInstanceMap.get(token);
          if (this.testContext.allERC20Tokens.indexOf(Token) > -1) {
            await Token.setBalance(this.context.feeHolder.address, 1);
            await Token.addBalance(minerFeeRecipient, 1);
          }
        }
        // Add a balance to the owner balances
        // const TokenB = this.testContext.tokenAddrInstanceMap.get(order.tokenB);
        // await TokenB.setBalance(order.owner, 1);
      }
      await dummyExchange.batchAddFeeBalances(feePayments.getData());
    }

    const ringsGenerator = new pjs.RingsGenerator(this.context);
    await ringsGenerator.setupRingsAsync(ringsInfo);
    const bs = ringsGenerator.toSubmitableParam(ringsInfo);

    // Update block number and block timestamp
    this.context.blockNumber = web3.eth.blockNumber;
    this.context.blockTimestamp = web3.eth.getBlock(this.context.blockNumber).timestamp;

    const simulator = new pjs.ProtocolSimulator(this.context);
    const txOrigin = ringsInfo.transactionOrigin ? ringsInfo.transactionOrigin :
                                                   this.testContext.transactionOrigin;
    const deserializedRingsInfo = simulator.deserialize(bs, txOrigin);
    this.assertEqualsRingsInfo(deserializedRingsInfo, ringsInfo);
    const filledAmounts: { [hash: string]: BigNumber; } = {};
    let report: pjs.SimulatorReport = {
      reverted: true,
      ringMinedEvents: [],
      invalidRingEvents: [],
      transferItems: [],
      feeBalancesBefore: new pjs.BalanceBook(),
      feeBalancesAfter: new pjs.BalanceBook(),
      filledAmountsBefore: {},
      filledAmountsAfter: {},
      balancesBefore: new pjs.BalanceBook(),
      balancesAfter: new pjs.BalanceBook(),
      payments: {rings: []},
    };
    let tx = null;
    try {
      report = await simulator.simulateAndReport(deserializedRingsInfo);
      this.logDetailedTokenTransfers(ringsInfo, report);
    } catch (err) {
      pjs.logDebug("Simulator reverted -> " + err);
      report.revertMessage = err.message;
    }

    pjs.logDebug("shouldThrow:", report.reverted);

    const ringSubmitter = submitter ? submitter : this.ringSubmitter;
    if (report.reverted) {
      tx = await pjs.expectThrow(ringSubmitter.submitRings(bs, {from: txOrigin}), report.revertMessage);
    } else {
      tx = await ringSubmitter.submitRings(bs, {from: txOrigin});
      pjs.logInfo("\x1b[46m%s\x1b[0m", "gas used: " + tx.receipt.gasUsed);
    }
    const transferEvents = await this.getTransferEvents(this.testContext.allERC20Tokens,
                                                        this.testContext.allERC1400Tokens,
                                                        web3.eth.blockNumber);
    const ringMinedEvents = await this.getRingMinedEvents(web3.eth.blockNumber);
    const invalidRingEvents = await this.getInvalidRingEvents(web3.eth.blockNumber);
    this.assertTransfers(deserializedRingsInfo, transferEvents, report.transferItems);
    this.assertRingMinedEvents(ringMinedEvents, report.ringMinedEvents);
    this.assertInvalidRingEvents(invalidRingEvents, report.invalidRingEvents);
    await this.assertFeeBalances(deserializedRingsInfo, report.feeBalancesBefore, report.feeBalancesAfter);
    await this.assertFilledAmounts(deserializedRingsInfo, report.filledAmountsAfter);

    const addressBook = this.getAddressBook(ringsInfo);
    const protocolValidator = new pjs.ProtocolValidator(this.context);
    await protocolValidator.verifyTransaction(ringsInfo, report, addressBook);

    // await this.watchAndPrintEvent(this.ringSubmitter, "LogUint");

    return {tx, report};
  }

  public async initializeTradeDelegate() {
    await this.context.tradeDelegate.authorizeAddress(this.ringSubmitter.address, {from: this.testContext.deployer});

    for (const token of this.testContext.allERC20Tokens) {
      // approve once for all orders:
      for (const orderOwner of this.testContext.orderOwners) {
        await token.approve(this.context.tradeDelegate.address, 1e32, {from: orderOwner});
      }
    }
    for (const token of this.testContext.allERC1400Tokens) {
      // approve once for all orders:
      for (const orderOwner of this.testContext.orderOwners) {
        await token.authorizeOperator(this.context.tradeDelegate.address, {from: orderOwner});
      }
    }
  }

  public async lockLRC(user: string, targetRebateRate: number) {
    const {
      DummyToken,
      BurnRateTable,
    } = new Artifacts(artifacts);

    const LRC = await DummyToken.at(this.context.lrcAddress);
    const burnRateTable = await BurnRateTable.deployed();
    const totalLRCSupply = await LRC.totalSupply();

    // Calculate the needed funds to upgrade the tier
    const LOCK_BASE_PERCENTAGE = (await this.context.burnRateTable.LOCK_BASE_PERCENTAGE()).toNumber();
    const maxLockPercentage = (await this.context.burnRateTable.MAX_LOCK_PERCENTAGE()).toNumber();
    const maxLockAmount = Math.floor(totalLRCSupply * maxLockPercentage / LOCK_BASE_PERCENTAGE);

    // How much we need to lock to get the target rebate rate
    const lockAmount = maxLockAmount * targetRebateRate;

    await LRC.transfer(user, lockAmount, {from: this.testContext.deployer});
    await LRC.approve(this.context.burnRateTable.address, lockAmount, {from: user});

    await burnRateTable.lock(lockAmount, {from: user});
  }

  public async cleanTradeHistory() {
    const {
      RingSubmitter,
      OrderRegistry,
      TradeDelegate,
      FeeHolder,
      WETHToken,
      BrokerRegistry,
    } = new Artifacts(artifacts);

    const tradeDelegate = await TradeDelegate.new();
    const feeHolder = await FeeHolder.new(tradeDelegate.address);
    const brokerRegistry = await BrokerRegistry.new();
    this.ringSubmitter = await RingSubmitter.new(
      this.context.lrcAddress,
      WETHToken.address,
      tradeDelegate.address,
      brokerRegistry.address,
      OrderRegistry.address,
      feeHolder.address,
      this.context.orderBook.address,
      this.context.burnRateTable.address,
    );

    const orderBrokerRegistryAddress = await this.ringSubmitter.orderBrokerRegistryAddress();
    // const minerBrokerRegistryAddress = await this.ringSubmitter.minerBrokerRegistryAddress();
    const feePercentageBase = (await this.ringSubmitter.FEE_PERCENTAGE_BASE()).toNumber();
    const ringIndex = (await this.ringSubmitter.ringIndex()).toNumber();

    const currBlockNumber = web3.eth.blockNumber;
    const currBlockTimestamp = web3.eth.getBlock(currBlockNumber).timestamp;
    this.context = new pjs.Context(currBlockNumber,
                                   currBlockTimestamp,
                                   tradeDelegate.address,
                                   orderBrokerRegistryAddress,
                                   OrderRegistry.address,
                                   feeHolder.address,
                                   this.context.orderBook.address,
                                   this.context.burnRateTable.address,
                                   this.context.lrcAddress,
                                   feePercentageBase,
                                   ringIndex);

    await this.initializeTradeDelegate();
  }

  private getPrivateKey(address: string) {
    const textData = fs.readFileSync("./ganache_account_keys.txt", "ascii");
    const data = JSON.parse(textData);
    return data.private_keys[address];
  }

  // private functions:
  private async createContractContext() {
    const {
      RingSubmitter,
      OrderRegistry,
      TradeDelegate,
      FeeHolder,
      OrderBook,
      BurnRateTable,
      LRCToken,
    } = new Artifacts(artifacts);

    const [ringSubmitter, tradeDelegate, orderRegistry,
           feeHolder, orderBook, burnRateTable, lrcToken] = await Promise.all([
        RingSubmitter.deployed(),
        TradeDelegate.deployed(),
        OrderRegistry.deployed(),
        FeeHolder.deployed(),
        OrderBook.deployed(),
        BurnRateTable.deployed(),
        LRCToken.deployed(),
      ]);

    this.ringSubmitter = ringSubmitter;

    const orderBrokerRegistryAddress = await ringSubmitter.orderBrokerRegistryAddress();
    const feePercentageBase = (await ringSubmitter.FEE_PERCENTAGE_BASE()).toNumber();
    const ringIndex = (await ringSubmitter.ringIndex()).toNumber();

    const currBlockNumber = web3.eth.blockNumber;
    const currBlockTimestamp = web3.eth.getBlock(currBlockNumber).timestamp;
    return new pjs.Context(currBlockNumber,
                           currBlockTimestamp,
                           TradeDelegate.address,
                           orderBrokerRegistryAddress,
                           OrderRegistry.address,
                           FeeHolder.address,
                           OrderBook.address,
                           BurnRateTable.address,
                           LRCToken.address,
                           feePercentageBase,
                           ringIndex);
  }

  private async createExchangeTestContext(accounts: string[]) {
    const {
      LRCToken,
      GTOToken,
      RDNToken,
      REPToken,
      WETHToken,
      STAToken,
      STBToken,
      TESTToken,
      SECTESTToken,
    } = new Artifacts(artifacts);

    const tokenSymbolAddrMap = new Map<string, string>();
    const tokenAddrSymbolMap = new Map<string, string>();
    const tokenAddrInstanceMap = new Map<string, any>();

    const [lrc, gto, rdn, rep, weth, sta, stb, test, sectest] = await Promise.all([
      LRCToken.deployed(),
      GTOToken.deployed(),
      RDNToken.deployed(),
      REPToken.deployed(),
      WETHToken.deployed(),
      STAToken.deployed(),
      STBToken.deployed(),
      TESTToken.deployed(),
      SECTESTToken.deployed(),
    ]);

    const allERC20Tokens = [lrc, gto, rdn, rep, weth, test];
    const allERC1400Tokens = [sta, stb, sectest];

    tokenSymbolAddrMap.set("LRC", LRCToken.address);
    tokenSymbolAddrMap.set("GTO", GTOToken.address);
    tokenSymbolAddrMap.set("RDN", RDNToken.address);
    tokenSymbolAddrMap.set("REP", REPToken.address);
    tokenSymbolAddrMap.set("WETH", WETHToken.address);
    tokenSymbolAddrMap.set("STA", STAToken.address);
    tokenSymbolAddrMap.set("STB", STBToken.address);
    tokenSymbolAddrMap.set("TEST", TESTToken.address);
    tokenSymbolAddrMap.set("SECTEST", SECTESTToken.address);

    tokenAddrSymbolMap.set(LRCToken.address, "LRC");
    tokenAddrSymbolMap.set(GTOToken.address, "GTO");
    tokenAddrSymbolMap.set(RDNToken.address, "RDN");
    tokenAddrSymbolMap.set(REPToken.address, "REP");
    tokenAddrSymbolMap.set(WETHToken.address, "WETH");
    tokenAddrSymbolMap.set(STAToken.address, "STA");
    tokenAddrSymbolMap.set(STBToken.address, "STB");
    tokenAddrSymbolMap.set(TESTToken.address, "TEST");
    tokenAddrSymbolMap.set(SECTESTToken.address, "SECTEST");

    tokenAddrInstanceMap.set(LRCToken.address, lrc);
    tokenAddrInstanceMap.set(GTOToken.address, gto);
    tokenAddrInstanceMap.set(RDNToken.address, rdn);
    tokenAddrInstanceMap.set(REPToken.address, rep);
    tokenAddrInstanceMap.set(WETHToken.address, weth);
    tokenAddrInstanceMap.set(STAToken.address, sta);
    tokenAddrInstanceMap.set(STBToken.address, stb);
    tokenAddrInstanceMap.set(TESTToken.address, test);
    tokenAddrInstanceMap.set(SECTESTToken.address, sectest);

    const deployer = accounts[0];
    const transactionOrigin = accounts[1];
    const feeRecipient = accounts[2];
    const miner = accounts[3];
    const orderOwners = accounts.slice(4, 14);
    const orderDualAuthAddr = accounts.slice(14, 24);
    const allOrderTokenRecipients = accounts.slice(24, 28);
    const wallets = accounts.slice(28, 32);
    const brokers =  accounts.slice(32, 36);

    return new ExchangeTestContext(deployer,
                                   transactionOrigin,
                                   feeRecipient,
                                   miner,
                                   orderOwners,
                                   orderDualAuthAddr,
                                   allOrderTokenRecipients,
                                   wallets,
                                   brokers,
                                   tokenSymbolAddrMap,
                                   tokenAddrSymbolMap,
                                   tokenAddrInstanceMap,
                                   allERC20Tokens,
                                   allERC1400Tokens);
  }

}
