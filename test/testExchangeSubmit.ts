import { BigNumber } from "bignumber.js";
import * as pjs from "protocol2-js";
import { Artifacts } from "../util/Artifacts";
import { ringsInfoList } from "./rings_config";
import { ExchangeTestUtil } from "./testExchangeUtil";

const {
  DummyExchange,
  OrderBook,
  OrderRegistry,
  TESTToken,
  SECTESTToken,
  DummyERC1400Token,
} = new Artifacts(artifacts);

const ContractOrderOwner = artifacts.require("ContractOrderOwner");

contract("Exchange_Submit", (accounts: string[]) => {

  let exchangeTestUtil: ExchangeTestUtil;

  let dummyExchange: any;
  let orderBook: any;
  let orderRegistry: any;
  let contractOrderOwner: any;

  const checkFilled = async (order: pjs.OrderInfo, expected: number) => {
    const filled = await exchangeTestUtil.context.tradeDelegate.filled("0x" + order.hash.toString("hex")).toNumber();
    assert.equal(filled, expected, "Order fill different than expected");
  };

  before( async () => {
    exchangeTestUtil = new ExchangeTestUtil();
    await exchangeTestUtil.initialize(accounts);
    orderBook = await OrderBook.deployed();
    orderRegistry = await OrderRegistry.deployed();

    // Create dummy exchange and authorize it
    dummyExchange = await DummyExchange.new(exchangeTestUtil.context.tradeDelegate.address,
                                            exchangeTestUtil.context.feeHolder.address,
                                            exchangeTestUtil.ringSubmitter.address);
    await exchangeTestUtil.context.tradeDelegate.authorizeAddress(dummyExchange.address,
                                                                  {from: exchangeTestUtil.testContext.deployer});

    contractOrderOwner = await ContractOrderOwner.new(exchangeTestUtil.context.orderBook.address, "0x0");
  });

  describe("submitRing", () => {

    for (const ringsInfo of ringsInfoList) {
      it(ringsInfo.description, async () => {
        await exchangeTestUtil.setupRings(ringsInfo);
        await exchangeTestUtil.submitRingsAndSimulate(ringsInfo, dummyExchange);
      });
    }

    it("order filled in multiple rings in different transactions", async () => {
      const order: pjs.OrderInfo = {
        index: 0,
        tokenS: "WETH",
        tokenB: "GTO",
        amountS: 100e18,
        amountB: 10e18,
      };

      // First transaction
      const ringsInfo1: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          order,
          {
            tokenS: "GTO",
            tokenB: "WETH",
            amountS: 5.1e18,
            amountB: 50e18,
          },
        ],
      };
      await exchangeTestUtil.setupRings(ringsInfo1);
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo1);
      // First order buys 5.1 GTO and pays 50 WETH + 1 WETH margin
      await checkFilled(order, 51e18);
      // Second order is completely filled at the given rate
      await checkFilled(ringsInfo1.orders[1], 5.1e18);

      // Second transaction
      const ringsInfo2: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          order,
          {
            tokenS: "GTO",
            tokenB: "WETH",
            amountS: 6e18,
            amountB: 60e18,
          },
        ],
      };
      // Reset the dual author signature so it is recalculated for the second ring
      order.dualAuthSig = undefined;
      await exchangeTestUtil.setupRings(ringsInfo2);
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo2);
      // First order buys 4.9 GTO at the given rate for 49 WETH
      await checkFilled(order, 100e18);
      // Second order buys 49 WETH at the given rate for 4.9 GTO
      await checkFilled(ringsInfo2.orders[1], 4.9e18);
    });

    it("order owner has not approved sufficient funds to the trade delegate contract", async () => {
      // First transaction
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          {
            tokenS: "WETH",
            tokenB: "GTO",
            amountS: 100e18,
            amountB: 10e18,
          },
          {
            tokenS: "GTO",
            tokenB: "WETH",
            amountS: 10e18,
            amountB: 100e18,
          },
        ],
      };
      ringsInfo.orders[0].owner = exchangeTestUtil.testContext.orderDualAuthAddrs[0];
      await exchangeTestUtil.setupRings(ringsInfo);

      // Nothing approved for tokenS or feeToken, orders should remain completely unfilled
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      await checkFilled(ringsInfo.orders[0], 0e18);
      await checkFilled(ringsInfo.orders[1], 0e18);

      // Only approve a part of the tokenS amount, feeToken cannot be used
      const tokenS = exchangeTestUtil.testContext.tokenAddrInstanceMap.get(ringsInfo.orders[0].tokenS);
      await tokenS.approve(exchangeTestUtil.context.tradeDelegate.address,
                           ringsInfo.orders[0].amountS / 2,
                           {from: ringsInfo.orders[0].owner});
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      await checkFilled(ringsInfo.orders[0], 0);

      // Only approve a part of the feeToken amount now as well
      const tokenFee = exchangeTestUtil.testContext.tokenAddrInstanceMap.get(ringsInfo.orders[0].feeToken);
      await tokenFee.approve(exchangeTestUtil.context.tradeDelegate.address,
                           ringsInfo.orders[0].feeAmount / 4,
                           {from: ringsInfo.orders[0].owner});
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      await checkFilled(ringsInfo.orders[0], ringsInfo.orders[0].amountS / 4);

      // Approve amountS and feeAmount
      await tokenS.approve(exchangeTestUtil.context.tradeDelegate.address,
                           ringsInfo.orders[0].amountS,
                           {from: ringsInfo.orders[0].owner});
      await tokenFee.approve(exchangeTestUtil.context.tradeDelegate.address,
                           ringsInfo.orders[0].feeAmount,
                           {from: ringsInfo.orders[0].owner});
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      await checkFilled(ringsInfo.orders[0], ringsInfo.orders[0].amountS);
    });

    it("should be able to submit rings without a mining signature when miner == msg.sender", async () => {
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          {
            tokenS: "WETH",
            tokenB: "GTO",
            amountS: 100e18,
            amountB: 10e18,
          },
          {
            tokenS: "GTO",
            tokenB: "WETH",
            amountS: 10e18,
            amountB: 100e18,
          },
        ],
        transactionOrigin: exchangeTestUtil.testContext.transactionOrigin,
        feeRecipient: exchangeTestUtil.testContext.feeRecipient,
        miner: exchangeTestUtil.testContext.miner,
      };
      // miner != msg.sender
      await exchangeTestUtil.setupRings(ringsInfo);
      ringsInfo.sig = null;
      ringsInfo.expected = {
        revert: true,
        revertMessage: "INVALID_SIG",
      };
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      // miner == msg.sender
      ringsInfo.transactionOrigin = ringsInfo.miner;
      ringsInfo.sig = undefined;
      await exchangeTestUtil.setupRings(ringsInfo);
      ringsInfo.sig = null;
      ringsInfo.expected = {
        rings: [
          {
            orders: [
              {
                filledFraction: 1.0,
              },
              {
                filledFraction: 1.0,
              },
            ],
          },
        ],
      };
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
    });

    it("on-chain order should be able to dealed with off-chain order", async () => {
      const onChainOrder: pjs.OrderInfo = {
        index: 0,
        tokenS: "GTO",
        tokenB: "WETH",
        amountS: 10000e18,
        amountB: 3e18,
        onChain: true,
      };

      const offChainOrder: pjs.OrderInfo = {
        index: 1,
        tokenS: "WETH",
        tokenB: "GTO",
        amountS: 3e18,
        amountB: 10000e18,
        feeAmount: 1e18,
      };

      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          onChainOrder,
          offChainOrder,
        ],
      };

      await exchangeTestUtil.setupRings(ringsInfo);

      const orderUtil = new pjs.OrderUtil(undefined);
      const orderData = orderUtil.toOrderBookSubmitParams(onChainOrder);
      const fromBlock = web3.eth.blockNumber;
      await orderBook.submitOrder(orderData, {from: onChainOrder.owner});
      const events: any = await exchangeTestUtil.getEventsFromContract(orderBook, "OrderSubmitted", fromBlock);
      const orderHashOnChain = events[0].args.orderHash;
      const orderHash = "0x" + orderUtil.getOrderHash(onChainOrder).toString("hex");
      pjs.logDebug("orderHash:", orderHash);
      pjs.logDebug("orderHashOnChain:", orderHashOnChain);
      assert.equal(orderHashOnChain, orderHash, "order hash not equal");

      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
    });

    it("should be able to use an order with a contract as order owner", async () => {
      const onChainOrder: pjs.OrderInfo = {
        index: 0,
        owner: contractOrderOwner.address,
        tokenS: "GTO",
        tokenB: "WETH",
        amountS: 10e18,
        amountB: 10e18,
        onChain: true,
      };
      const offChainOrder: pjs.OrderInfo = {
        index: 1,
        tokenS: "WETH",
        tokenB: "GTO",
        amountS: 10e18,
        amountB: 10e18,
        feeAmount: 1e18,
        balanceS: 5e18,
      };
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          onChainOrder,
          offChainOrder,
        ],
      };
      await exchangeTestUtil.setupRings(ringsInfo);

      // Order not registered
      ringsInfo.expected = {
        rings: [
          {
            fail: true,
          },
        ],
      };
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);

      // Submit the order to the onchain OrderBook
      const orderUtil = new pjs.OrderUtil(undefined);
      const orderData = orderUtil.toOrderBookSubmitParams(onChainOrder);
      const orderHash = "0x" + orderUtil.getOrderHash(onChainOrder).toString("hex");
      const fromBlock = web3.eth.blockNumber;
      await contractOrderOwner.sumbitOrderToOrderBook(orderData, orderHash);
      const events: any = await exchangeTestUtil.getEventsFromContract(orderBook, "OrderSubmitted", fromBlock);
      const orderHashOnChain = events[0].args.orderHash;
      assert.equal(orderHashOnChain, orderHash, "order hash not equal");

      // Order registered, but the contract is not allowed to spend any tokens in TradeDelegate
      ringsInfo.expected = {
        rings: [
          {
            orders: [
              {
                filledFraction: 0.0,
              },
              {
                filledFraction: 0.0,
              },
            ],
          },
        ],
      };
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);

      // Allow the contract to spend tokenS
      await contractOrderOwner.approve(onChainOrder.tokenS, exchangeTestUtil.context.tradeDelegate.address, 1e32);
      // Still cannot pay any fees, so no tokens will be transferred
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      // Allow the contract to spend feeToken
      await contractOrderOwner.approve(onChainOrder.feeToken, exchangeTestUtil.context.tradeDelegate.address, 1e32);

      // Order is registered and the contract can pay in tokenS and feeToken
      ringsInfo.expected = {
        rings: [
          {
            orders: [
              {
                filledFraction: 0.5,
              },
              {
                filledFraction: 0.5,
              },
            ],
          },
        ],
      };
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
    });

    it("should be able to use an order with a contract as order broker", async () => {
      const onChainOrder: pjs.OrderInfo = {
        index: 0,
        broker: contractOrderOwner.address,
        tokenS: "GTO",
        tokenB: "WETH",
        amountS: 10e18,
        amountB: 10e18,
        onChain: true,
      };
      const offChainOrder: pjs.OrderInfo = {
        index: 1,
        tokenS: "WETH",
        tokenB: "GTO",
        amountS: 10e18,
        amountB: 10e18,
        feeAmount: 1e18,
        balanceS: 5e18,
      };
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          onChainOrder,
          offChainOrder,
        ],
      };
      await exchangeTestUtil.setupRings(ringsInfo);

      // Order not registered
      ringsInfo.expected = {
        rings: [
          {
            fail: true,
          },
        ],
      };
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);

      // Submit the order to the onchain OrderBook
      const orderUtil = new pjs.OrderUtil(undefined);
      const orderData = orderUtil.toOrderBookSubmitParams(onChainOrder);
      const orderHash = "0x" + orderUtil.getOrderHash(onChainOrder).toString("hex");
      const fromBlock = web3.eth.blockNumber;
      await contractOrderOwner.sumbitOrderToOrderBook(orderData, orderHash);
      const events: any = await exchangeTestUtil.getEventsFromContract(orderBook, "OrderSubmitted", fromBlock);
      const orderHashOnChain = events[0].args.orderHash;
      assert.equal(orderHashOnChain, orderHash, "order hash not equal");

      // Order is registered, but the broker is not
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);

      // Register the broker without interceptor
      const emptyAddr = "0x0000000000000000000000000000000000000000";
      await exchangeTestUtil.registerOrderBrokerChecked(onChainOrder.owner, onChainOrder.broker, emptyAddr);

      // Order and broker is registered
      ringsInfo.expected = {
        rings: [
          {
            orders: [
              {
                filledFraction: 0.5,
              },
              {
                filledFraction: 0.5,
              },
            ],
          },
        ],
      };
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
    });

    it("Should be able to use an order registered in the order registry", async () => {
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          {
            tokenS: "WETH",
            tokenB: "GTO",
            amountS: 100e18,
            amountB: 10e18,
          },
          {
            tokenS: "GTO",
            tokenB: "WETH",
            amountS: 1e18,
            amountB: 10e18,
          },
        ],
      };
      await exchangeTestUtil.setupRings(ringsInfo);
      const order = ringsInfo.orders[1];
      // Don't send the signature for the order so it needs to be validated differently
      order.sig = null;

      // No signature and the hash is not registered
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      await exchangeTestUtil.checkFilled(order.hash, 0);

      // Register the order hash
      await orderRegistry.registerOrderHash("0x" + order.hash.toString("hex"), {from: order.owner});

      // Retry again now the order hash is registered
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      await exchangeTestUtil.checkFilled(order.hash, order.amountS);
    });

    it("should be able to get different burn rates by using different tokens to pay fees", async () => {
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          {
            tokenS: "WETH",
            tokenB: "GTO",
            amountS: 10e18,
            amountB: 10e18,
            feeToken: "LRC",
            feeAmount: 1e18,
            walletAddr: "0",
            walletSplitPercentage: 25,
            balanceS: 5e18,
          },
          {
            tokenS: "GTO",
            tokenB: "WETH",
            amountS: 10e18,
            amountB: 10e18,
            feeToken: "REP",
            feeAmount: 1e18,
            walletAddr: "0",
            walletSplitPercentage: 25,
          },
        ],
      };
      await exchangeTestUtil.setupRings(ringsInfo);
      const order0 = ringsInfo.orders[0];
      const order1 = ringsInfo.orders[1];
      const feeRecipient = ringsInfo.feeRecipient;
      const burnRateTable = exchangeTestUtil.context.burnRateTable;

      // Get the burn rates of the tokens
      const BURN_BASE_PERCENTAGE = (await burnRateTable.BURN_BASE_PERCENTAGE()).toNumber();
      const burnRate0 = (await burnRateTable.getBurnRate(order0.feeToken)).toNumber() & 0xFFFF;
      const burnRate1 = (await burnRateTable.getBurnRate(order1.feeToken)).toNumber() & 0xFFFF;
      assert(burnRate0 !== burnRate1, "Tokens should have different burn rates");

      // Orders will be filled 50%
      const {tx, report} = await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      const feeReceivedMiner0 = report.feeBalancesAfter.getBalance(feeRecipient, order0.feeToken)
                                .minus(report.feeBalancesBefore.getBalance(feeRecipient, order0.feeToken));
      const feeReceivedWallet0 = report.feeBalancesAfter.getBalance(order0.walletAddr, order0.feeToken)
                                 .minus(report.feeBalancesBefore.getBalance(order0.walletAddr, order0.feeToken));
      const feeReceivedMiner1 = report.feeBalancesAfter.getBalance(feeRecipient, order1.feeToken)
                                .minus(report.feeBalancesBefore.getBalance(feeRecipient, order1.feeToken));
      const feeReceivedWallet1 = report.feeBalancesAfter.getBalance(order1.walletAddr, order1.feeToken)
                                 .minus(report.feeBalancesBefore.getBalance(order1.walletAddr, order1.feeToken));
      // Wallet percentage split is 25% so miner gets 3x the fee as the wallet
      assert.equal(feeReceivedMiner0.toNumber(), 3 * feeReceivedWallet0.toNumber(),
                   "Wallet fee == Miner fee");
      assert.equal(feeReceivedMiner1.toNumber(), 3 * feeReceivedWallet1.toNumber(),
                   "Wallet fee == Miner fee");

      // Orders will be filled 50% and walletSplitPercentage is set to 25%
      const expectedFee0 = new BigNumber(order0.feeAmount / 8)
                           .mul(BURN_BASE_PERCENTAGE - burnRate0)
                           .dividedToIntegerBy(BURN_BASE_PERCENTAGE);
      const expectedFee1 = new BigNumber(order1.feeAmount / 8)
                           .mul(BURN_BASE_PERCENTAGE - burnRate1)
                           .dividedToIntegerBy(BURN_BASE_PERCENTAGE);
      // Verify the fee payments
      assert.equal(feeReceivedMiner0.toNumber(), 3 * expectedFee0.toNumber(), "fee should match expected value");
      assert.equal(feeReceivedWallet0.toNumber(), expectedFee0.toNumber(), "fee should match expected value");
      assert.equal(feeReceivedMiner1.toNumber(), 3 * expectedFee1.toNumber(), "fee should match expected value");
      assert.equal(feeReceivedWallet1.toNumber(), expectedFee1.toNumber(), "fee should match expected value");
    });

    it("should be able to submit an order without the broker signature when partially filled", async () => {
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          {
            tokenS: "WETH",
            tokenB: "GTO",
            amountS: 100e18,
            amountB: 100e18,
          },
          {
            tokenS: "GTO",
            tokenB: "WETH",
            amountS: 100e18,
            amountB: 100e18,
          },
        ],
      };
      await exchangeTestUtil.setupRings(ringsInfo);
      const order = ringsInfo.orders[0];
      order.balanceS = order.amountS / 2;
      await exchangeTestUtil.setOrderBalances(order);

      const sig = order.sig;

      // Don't send the signature
      order.sig = null;
      // Order should be invalid so nothing should get filled
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      // Check fills
      await checkFilled(ringsInfo.orders[0], 0);
      await checkFilled(ringsInfo.orders[1], 0);

      // Send the signature this time
      order.sig = sig;
      // Fill the orders 50%
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      // Check fills
      await checkFilled(ringsInfo.orders[0], ringsInfo.orders[0].amountS / 2);
      await checkFilled(ringsInfo.orders[1], ringsInfo.orders[1].amountS / 2);

      // Don't send the signature anymore
      order.sig = null;
      // Give the order enough balance to fill 100%
      await exchangeTestUtil.setOrderBalances(order);
      // Fill the orders 100%
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      // Check fills
      await checkFilled(ringsInfo.orders[0], ringsInfo.orders[0].amountS);
      await checkFilled(ringsInfo.orders[1], ringsInfo.orders[1].amountS);
    });

    it("default values should be set to expected values", async () => {
      const lrcAddress = exchangeTestUtil.context.lrcAddress;
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          {
            tokenS: "WETH",
            tokenB: "GTO",
            amountS: 10e18,
            amountB: 10e18,
            walletSplitPercentage: 0,
          },
          {
            tokenS: "GTO",
            tokenB: "WETH",
            amountS: 10e18,
            amountB: 10e18,
            walletSplitPercentage: 0,
          },
        ],
        transactionOrigin: exchangeTestUtil.testContext.transactionOrigin,
        feeRecipient: null,
        miner: null,
      };
      await exchangeTestUtil.setupRings(ringsInfo);
      const {tx, report} = await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);

      // tx.origin is the default feeRecipient
      {
        const feeRecipient = ringsInfo.transactionOrigin;
        const feeBalanceBefore = report.feeBalancesBefore.getBalance(feeRecipient, lrcAddress);
        const feeBalanceAfter = report.feeBalancesAfter.getBalance(feeRecipient, lrcAddress);
        assert(feeBalanceAfter.gt(feeBalanceBefore), "tx.origin should be the default feeRecipient");
      }

      // LRC is the default feeToken
      {
        const callData = await exchangeTestUtil.deserializeRing(ringsInfo);
        const lrcAddressIndex = callData.indexOf(lrcAddress);
        assert.equal(lrcAddressIndex, -1, "LRC address should not be stored in the calldata");
        let numLRCTransfers = 0;
        for (const transfer of report.transferItems) {
          if (transfer.to === exchangeTestUtil.context.feeHolder.address) {
            assert.equal(transfer.token, lrcAddress, "LRC should be the default feeToken");
            numLRCTransfers++;
          }
        }
        assert.equal(numLRCTransfers, 2, "2 transfers to the fee contract expected");
      }

      // The order owner is the default tokenRecipient
      {
        for (const order of ringsInfo.orders) {
          const balanceBefore = report.balancesBefore.getBalance(order.owner, order.tokenB);
          const balanceAfter = report.balancesAfter.getBalance(order.owner, order.tokenB);
          assert.equal(balanceAfter.minus(balanceBefore).toNumber(), order.amountB,
                       "The order owner should receive the tokens bought");
        }
      }
    });

    it("should revert when a ERC20 token transfer fails", async () => {
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          {
            tokenS: "WETH",
            tokenB: "TEST",
            amountS: 10e18,
            amountB: 10e18,
          },
          {
            tokenS: "TEST",
            tokenB: "WETH",
            amountS: 10e18,
            amountB: 10e18,
          },
        ],
      };
      await exchangeTestUtil.setupRings(ringsInfo);

      // Setup the ring
      const ringsGenerator = new pjs.RingsGenerator(exchangeTestUtil.context);
      await ringsGenerator.setupRingsAsync(ringsInfo);
      const bs = ringsGenerator.toSubmitableParam(ringsInfo);

      // Fail the token transfer by throwing in transferFrom
      const TestToken = TESTToken.at(exchangeTestUtil.testContext.tokenSymbolAddrMap.get("TEST"));
      await TestToken.setTestCase(await TestToken.TEST_REQUIRE_FAIL());

      // submitRings should revert
      await pjs.expectThrow(
        exchangeTestUtil.ringSubmitter.submitRings(bs, {from: exchangeTestUtil.testContext.transactionOrigin}),
        "TRANSFER_FAILURE",
      );
    });

    it("should not be able to send ERC1400 tokens when canSend returns false", async () => {
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          {
            tokenS: "WETH",
            tokenB: "SECTEST",
            amountS: 10e18,
            amountB: 10e18,
            tokenTypeB: pjs.TokenType.ERC1400,
          },
          {
            tokenS: "SECTEST",
            tokenB: "WETH",
            amountS: 10e18,
            amountB: 10e18,
            tokenTypeS: pjs.TokenType.ERC1400,
          },
        ],
        expected: {
          rings: [
            {
              fail: true,
            },
          ],
        },
      };
      await exchangeTestUtil.setupRings(ringsInfo);

      // Disallow the token transfer
      const TestToken = SECTESTToken.at(exchangeTestUtil.testContext.tokenSymbolAddrMap.get("SECTEST"));
      await TestToken.setTestCase(await TestToken.TEST_CANSEND_FALSE());

      // Submit the ring. The ring should not settle.
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
    });

    it("should revert when a ERC1400 token transfer fails", async () => {
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          {
            tokenS: "WETH",
            tokenB: "SECTEST",
            amountS: 10e18,
            amountB: 10e18,
            tokenTypeB: pjs.TokenType.ERC1400,
            trancheB: "0x" + "01".repeat(32),
          },
          {
            tokenS: "SECTEST",
            tokenB: "WETH",
            amountS: 10e18,
            amountB: 10e18,
            tokenTypeS: pjs.TokenType.ERC1400,
            trancheS: "0x" + "01".repeat(32),
          },
        ],
      };
      await exchangeTestUtil.setupRings(ringsInfo);

      // Setup the ring
      const ringsGenerator = new pjs.RingsGenerator(exchangeTestUtil.context);
      await ringsGenerator.setupRingsAsync(ringsInfo);
      const bs = ringsGenerator.toSubmitableParam(ringsInfo);

      // Fail the token transfer by throwing in transferFrom
      const TestToken = SECTESTToken.at(exchangeTestUtil.testContext.tokenSymbolAddrMap.get("SECTEST"));
      await TestToken.setTestCase(await TestToken.TEST_SEND_REQUIRE_FAIL());

      // submitRings should revert
      await pjs.expectThrow(
        exchangeTestUtil.ringSubmitter.submitRings(bs, {from: exchangeTestUtil.testContext.transactionOrigin}),
        "TRANSFER_FAILURE",
      );
    });

    it("order owner should approve the trade delegate as an operator for an ERC1400 token", async () => {
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          {
            tokenS: "STA",
            tokenB: "WETH",
            amountS: 100e18,
            amountB: 10e18,
            trancheS: "0x" + "00".repeat(32),
            tokenTypeS: pjs.TokenType.ERC1400,
          },
          {
            tokenS: "WETH",
            tokenB: "STA",
            amountS: 10e18,
            amountB: 100e18,
            trancheB: "0x" + "00".repeat(32),
            tokenTypeB: pjs.TokenType.ERC1400,
          },
        ],
      };
      await exchangeTestUtil.setupRings(ringsInfo);

      const STAToken = DummyERC1400Token.at(exchangeTestUtil.testContext.tokenSymbolAddrMap.get("STA"));

      // TradeDelegate not approved as operator
      await STAToken.revokeOperator(exchangeTestUtil.context.tradeDelegate.address,
                                    {from: ringsInfo.orders[0].owner});
      ringsInfo.expected = {
        rings: [
          {
            orders: [
              {
                filledFraction: 0.0,
              },
              {
                filledFraction: 0.0,
              },
            ],
          },
        ],
      };
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);

      // TradeDelegate approved as operator
      await STAToken.authorizeOperator(exchangeTestUtil.context.tradeDelegate.address,
                                       {from: ringsInfo.orders[0].owner});
      ringsInfo.expected = {
        rings: [
          {
            orders: [
              {
                filledFraction: 1.0,
              },
              {
                filledFraction: 1.0,
              },
            ],
          },
        ],
      };
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
    });

    it("should not settle rings when token types don't match", async () => {
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          {
            tokenS: "WETH",
            tokenB: "LRC",
            amountS: 10e18,
            amountB: 10e18,
            tokenTypeB: pjs.TokenType.ERC20,
          },
          {
            tokenS: "LRC",
            tokenB: "WETH",
            amountS: 10e18,
            amountB: 10e18,
            tokenTypeS: pjs.TokenType.ERC20,
          },
        ],
      };
      await exchangeTestUtil.setupRings(ringsInfo);

      // Change the token type
      ringsInfo.orders[0].tokenTypeB = pjs.TokenType.ERC20;
      ringsInfo.orders[1].tokenTypeS = pjs.TokenType.ERC1400;

      // Setup the ring
      const ringsGenerator = new pjs.RingsGenerator(exchangeTestUtil.context);
      await ringsGenerator.setupRingsAsync(ringsInfo);
      const bs = ringsGenerator.toSubmitableParam(ringsInfo);

      // submitRings should not revert, but the orders should not get filled
      await exchangeTestUtil.ringSubmitter.submitRings(bs, {from: exchangeTestUtil.testContext.transactionOrigin});
      await checkFilled(ringsInfo.orders[0], 0);
      await checkFilled(ringsInfo.orders[1], 0);
    });

    it("should not be able to pass in the wrong token type", async () => {
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          {
            tokenS: "WETH",
            tokenB: "LRC",
            amountS: 10e18,
            amountB: 10e18,
            tokenTypeB: pjs.TokenType.ERC20,
            trancheB: "0x" + "01".repeat(32),
          },
          {
            tokenS: "LRC",
            tokenB: "WETH",
            amountS: 10e18,
            amountB: 10e18,
            tokenTypeS: pjs.TokenType.ERC20,
            trancheS: "0x" + "01".repeat(32),
          },
        ],
      };
      await exchangeTestUtil.setupRings(ringsInfo);

      // Change the token type
      ringsInfo.orders[0].tokenTypeB = pjs.TokenType.ERC1400;
      ringsInfo.orders[1].tokenTypeS = pjs.TokenType.ERC1400;

      // Setup the ring
      const ringsGenerator = new pjs.RingsGenerator(exchangeTestUtil.context);
      await ringsGenerator.setupRingsAsync(ringsInfo);
      const bs = ringsGenerator.toSubmitableParam(ringsInfo);

      // submitRings should revert
      await pjs.expectThrow(
        exchangeTestUtil.ringSubmitter.submitRings(bs, {from: exchangeTestUtil.testContext.transactionOrigin}),
        "UNSUPPORTED",
      );
    });

  });

});
