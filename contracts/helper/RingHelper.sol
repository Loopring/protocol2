/*

  Copyright 2017 Loopring Project Ltd (Loopring Foundation).

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/
pragma solidity 0.4.24;
pragma experimental "v0.5.0";
pragma experimental "ABIEncoderV2";

import "../iface/IRingSubmitter.sol";
import "../impl/BrokerInterceptorProxy.sol";
import "../impl/Data.sol";
import "../lib/ERC1400.sol";
import "../lib/ERC20.sol";
import "../lib/MathUint.sol";
import "../lib/MultihashUtil.sol";
import "./OrderHelper.sol";
import "./ParticipationHelper.sol";


/// @title RingHelper
library RingHelper {
    using MathUint for uint;
    using OrderHelper for Data.Order;
    using ParticipationHelper for Data.Participation;

    using BrokerInterceptorProxy for address;
    function updateHash(
        Data.Ring ring
        )
        internal
        pure
    {
        uint ringSize = ring.size;
        bytes32 hash;
        assembly {
            let data := mload(0x40)
            let ptr := data
            for { let i := 0 } lt(i, ringSize) { i := add(i, 1) } {
                let participations := mload(add(ring, 32))                              // ring.participations
                let participation := mload(add(participations, add(32, mul(i, 32))))    // participations[i]
                let order := mload(participation)                                       // participation.order

                let waiveFeePercentage := and(mload(add(order, 704)), 0xFFFF)           // order.waiveFeePercentage
                let orderHash := mload(add(order, 896))                                 // order.hash

                mstore(add(ptr, 2), waiveFeePercentage)
                mstore(ptr, orderHash)

                ptr := add(ptr, 34)
            }
            hash := keccak256(data, sub(ptr, data))
        }
        ring.hash = hash;
    }

    function calculateFillAmountAndFee(
        Data.Ring ring,
        Data.Context ctx
        )
        internal
    {
        // Invalid order data could cause a divide by zero in the calculations
        if (!ring.valid) {
            return;
        }

        uint i;
        int j;
        uint prevIndex;

        for (i = 0; i < ring.size; i++) {
            ring.participations[i].setMaxFillAmounts(
                ctx
            );
        }

        uint smallest = 0;
        for (j = int(ring.size) - 1; j >= 0; j--) {
            prevIndex = (uint(j) + ring.size - 1) % ring.size;
            smallest = calculateOrderFillAmounts(
                ctx,
                ring.participations[uint(j)],
                ring.participations[prevIndex],
                uint(j),
                smallest
            );
        }
        for (j = int(ring.size) - 1; j >= int(smallest); j--) {
            prevIndex = (uint(j) + ring.size - 1) % ring.size;
            calculateOrderFillAmounts(
                ctx,
                ring.participations[uint(j)],
                ring.participations[prevIndex],
                uint(j),
                smallest
            );
        }

        // Reserve the total amount tokenS used for all the orders
        // (e.g. the owner of order 0 could use LRC as feeToken in order 0, while
        // the same owner can also sell LRC in order 2).
        for (i = 0; i < ring.size; i++) {
            ring.participations[i].order.reserveAmountS(ring.participations[i].fillAmountS);
        }

        for (i = 0; i < ring.size; i++) {
            prevIndex = (i + ring.size - 1) % ring.size;

            // Check if we can transfer the tokens
            if (ring.participations[i].order.tokenTypeS == Data.TokenType.ERC1400) {
                (byte ESC, , bytes32 destTranche) = ERC1400(ring.participations[i].order.tokenS).canSend(
                    ring.participations[i].order.owner,
                    ring.participations[prevIndex].order.tokenRecipient,
                    ring.participations[i].order.trancheS,
                    ring.participations[i].fillAmountS,
                    ring.participations[i].order.transferDataS
                );
                ring.valid = ring.valid && ESC == 0x01;
                ring.valid = ring.valid && destTranche == ring.participations[prevIndex].order.trancheB;
            }

            bool valid = ring.participations[i].calculateFees(ring.participations[prevIndex], ctx);
            if (!valid) {
                ring.valid = false;
                break;
            }

            int16 waiveFeePercentage = ring.participations[i].order.waiveFeePercentage;
            if (waiveFeePercentage < 0) {
                ring.minerFeesToOrdersPercentage += uint(-waiveFeePercentage);
            }
        }
        // Miner can only distribute 100% of its fees to all orders combined
        ring.valid = ring.valid && (ring.minerFeesToOrdersPercentage <= ctx.feePercentageBase);

        // Ring calculations are done. Make sure te remove all spendable reservations for this ring
        for (i = 0; i < ring.size; i++) {
            ring.participations[i].order.resetReservations();
        }
    }

    function calculateOrderFillAmounts(
        Data.Context ctx,
        Data.Participation p,
        Data.Participation prevP,
        uint i,
        uint smallest
        )
        internal
        pure
        returns (uint smallest_)
    {
        // Default to the same smallest index
        smallest_ = smallest;

        uint postFeeFillAmountS = p.fillAmountS;
        uint tokenSFeePercentage = p.order.tokenSFeePercentage;
        if (tokenSFeePercentage > 0) {
            postFeeFillAmountS = p.fillAmountS
                .mul(ctx.feePercentageBase - tokenSFeePercentage) / ctx.feePercentageBase;
        }

        if (prevP.fillAmountB > postFeeFillAmountS) {
            smallest_ = i;
            prevP.fillAmountB = postFeeFillAmountS;
            prevP.fillAmountS = postFeeFillAmountS.mul(prevP.order.amountS) / prevP.order.amountB;
        }
    }

    function checkOrdersValid(
        Data.Ring ring
        )
        internal
        pure
    {
        ring.valid = ring.valid && (ring.size > 1 && ring.size <= 8); // invalid ring size
        for (uint i = 0; i < ring.size; i++) {
            ring.valid = ring.valid && ring.participations[i].order.valid;
        }
    }

    function checkForSubRings(
        Data.Ring ring
        )
        internal
        pure
    {
        for (uint i = 0; i < ring.size - 1; i++) {
            address tokenS = ring.participations[i].order.tokenS;
            for (uint j = i + 1; j < ring.size; j++) {
                ring.valid = ring.valid && (tokenS != ring.participations[j].order.tokenS);
            }
        }
    }

    function adjustOrderStates(
        Data.Ring ring
        )
        internal
        pure
    {
        // Adjust the orders
        for (uint i = 0; i < ring.size; i++) {
            ring.participations[i].adjustOrderState();
        }
    }


    function revertOrderStats(
        Data.Ring ring
        )
        internal
        pure
    {
        for (uint i = 0; i < ring.size; i++) {
            ring.participations[i].revertOrderState();
        }
    }

    function doPayments(
        Data.Ring ring,
        Data.Context ctx,
        Data.Mining mining
        )
        internal
    {
        payFees(ring, ctx, mining);
        transferTokens(ring, ctx, mining.feeRecipient);
    }

    function generateFills(
        Data.Ring ring
        )
        internal
        pure
        returns (IRingSubmitter.Fill[] memory fills)
    {
        uint ringSize = ring.size;
        uint arrayDataSize = (ringSize + 1) * 32;
        assembly {
            fills := mload(0x40)
            mstore(add(fills, 0), ringSize)
            let fill := add(fills, arrayDataSize)
            let participations := mload(add(ring, 32))                                 // ring.participations

            for { let i := 0 } lt(i, ringSize) { i := add(i, 1) } {
                // Store the memory location of this fill in the fills array
                mstore(add(fills, mul(add(i, 1), 32)), fill)

                let participation := mload(add(participations, add(32, mul(i, 32))))   // participations[i]
                let order := mload(participation)                                      // participation.order

                mstore(add(fill,   0), mload(add(order, 896)))                         // order.hash
                mstore(add(fill,  32), mload(add(order,  32)))                         // order.owner
                mstore(add(fill,  64), mload(add(order,  64)))                         // order.tokenS
                mstore(add(fill,  96), mload(add(participation, 256)))                 // participation.fillAmountS
                mstore(add(fill, 128), mload(add(participation,  32)))                 // participation.splitS
                mstore(add(fill, 160), mload(add(participation,  64)))                 // participation.feeAmount

                fill := add(fill, 192)                                                 // 6 * 32
            }
            mstore(0x40, fill)
        }
    }

    function transferTokens(
        Data.Ring ring,
        Data.Context ctx,
        address feeRecipient
        )
        internal
    {
        for (uint i = 0; i < ring.size; i++) {
            transferTokensForParticipation(
                ctx,
                feeRecipient,
                ring.participations[i],
                ring.participations[(i + ring.size - 1) % ring.size]
            );
        }
    }

    function transferTokensForParticipation(
        Data.Context ctx,
        address feeRecipient,
        Data.Participation p,
        Data.Participation prevP
        )
        internal
    {
        uint buyerFeeAmountAfterRebateB = prevP.feeAmountB.sub(prevP.rebateB);

        // If the buyer needs to pay fees in tokenB, the seller needs
        // to send the tokenS amount to the fee holder contract
        uint amountSToBuyer = p.fillAmountS
            .sub(p.feeAmountS)
            .sub(buyerFeeAmountAfterRebateB);

        uint amountSToFeeHolder = p.feeAmountS
            .sub(p.rebateS)
            .add(buyerFeeAmountAfterRebateB);

        uint amountFeeToFeeHolder = p.feeAmount
            .sub(p.rebateFee);

        if (p.order.tokenS == p.order.feeToken) {
            amountSToFeeHolder = amountSToFeeHolder.add(amountFeeToFeeHolder);
            amountFeeToFeeHolder = 0;
        }

        uint margin = p.splitS;
        // Don't pay out the margin to the miner if it's a security token
        if (p.order.tokenTypeS == Data.TokenType.ERC1400) {
            margin = 0;
        }

        // Transfers
        ctx.transferPtr = addTokenTransfer(
            ctx.transferData,
            ctx.transferPtr,
            p.order.tokenTypeFee,
            0x0,
            p.order.feeToken,
            p.order.owner,
            address(ctx.feeHolder),
            amountFeeToFeeHolder
        );
        ctx.transferPtr = addTokenTransfer(
            ctx.transferData,
            ctx.transferPtr,
            p.order.tokenTypeS,
            p.order.trancheS,
            p.order.tokenS,
            p.order.owner,
            address(ctx.feeHolder),
            amountSToFeeHolder
        );
        ctx.transferPtr = addTokenTransfer(
            ctx.transferData,
            ctx.transferPtr,
            p.order.tokenTypeS,
            p.order.trancheS,
            p.order.tokenS,
            p.order.owner,
            prevP.order.tokenRecipient,
            amountSToBuyer
        );

        // Miner (or for P2P the taker) gets the margin without sharing it with the wallet or burning
        ctx.transferPtr = addTokenTransfer(
            ctx.transferData,
            ctx.transferPtr,
            p.order.tokenTypeS,
            p.order.trancheS,
            p.order.tokenS,
            p.order.owner,
            feeRecipient,
            margin
        );

        // onTokenSpent broker callbacks
        if (p.order.brokerInterceptor != 0x0) {
            onTokenSpent(
                p.order.brokerInterceptor,
                p.order.owner,
                p.order.broker,
                p.order.tokenS,
                amountSToBuyer + amountSToFeeHolder + margin
            );
            onTokenSpent(
                p.order.brokerInterceptor,
                p.order.owner,
                p.order.broker,
                p.order.feeToken,
                amountFeeToFeeHolder
            );
        }
    }

    function addTokenTransfer(
        uint data,
        uint ptr,
        Data.TokenType tokenType,
        bytes32 tranche,
        address token,
        address from,
        address to,
        uint amount
        )
        internal
        pure
        returns (uint)
    {
        if (amount > 0 && from != to) {
            assembly {
                // Try to find an existing fee payment of the same token to the same owner
                let addNew := 1
                for { let p := data } lt(p, ptr) { p := add(p, 192) } {
                    let dataToken := mload(add(p,  0))
                    let dataFrom := mload(add(p, 32))
                    let dataTo := mload(add(p, 64))
                    let dataTranche := mload(add(p, 160))
                    // if(token == dataToken && from == dataFrom && to == dataTo && tranche == dataTranche)
                    if and(and(and(
                        eq(token, dataToken),
                        eq(from, dataFrom)),
                        eq(to, dataTo)),
                        eq(tranche, dataTranche)) {
                        let dataAmount := mload(add(p, 96))
                        // dataAmount = amount.add(dataAmount);
                        dataAmount := add(amount, dataAmount)
                        // require(dataAmount > amount) (safe math)
                        if sub(1, gt(dataAmount, amount)) {
                            revert(0, 0)
                        }
                        mstore(add(p, 96), dataAmount)
                        addNew := 0
                        // End the loop
                        p := ptr
                    }
                }
                // Add a new transfer
                if eq(addNew, 1) {
                    mstore(add(ptr,  0), token)
                    mstore(add(ptr, 32), from)
                    mstore(add(ptr, 64), to)
                    mstore(add(ptr, 96), amount)
                    mstore(add(ptr, 128), tokenType)
                    mstore(add(ptr, 160), tranche)
                    ptr := add(ptr, 192)
                }
            }
            return ptr;
        } else {
            return ptr;
        }
    }

    function onTokenSpent(
        address brokerInterceptor,
        address owner,
        address broker,
        address token,
        uint    amount
        )
        internal
    {
        if (brokerInterceptor == 0x0 || amount == 0) {
            return;
        } else {
            brokerInterceptor.onTokenSpentSafe(
                owner,
                broker,
                token,
                amount
            );
        }
    }

    function payFees(
        Data.Ring ring,
        Data.Context ctx,
        Data.Mining mining
        )
        internal
        view
    {
        Data.FeeContext memory feeCtx;
        feeCtx.ring = ring;
        feeCtx.ctx = ctx;
        feeCtx.feeRecipient = mining.feeRecipient;
        for (uint i = 0; i < ring.size; i++) {
            payFeesForParticipation(
                feeCtx,
                ring.participations[i]
            );
        }
    }

    function payFeesForParticipation(
        Data.FeeContext memory feeCtx,
        Data.Participation memory p
        )
        internal
        view
        returns (uint)
    {
        feeCtx.walletPercentage = p.order.P2P ? 100 : (p.order.wallet == 0x0 ? 0 : p.order.walletSplitPercentage);
        feeCtx.waiveFeePercentage = p.order.waiveFeePercentage;
        feeCtx.owner = p.order.owner;
        feeCtx.wallet = p.order.wallet;
        feeCtx.P2P = p.order.P2P;

        p.rebateFee = payFeesAndBurn(
            feeCtx,
            p.order.feeToken,
            p.feeAmount
        );
        p.rebateS = payFeesAndBurn(
            feeCtx,
            p.order.tokenS,
            p.feeAmountS
        );
        p.rebateB = payFeesAndBurn(
            feeCtx,
            p.order.tokenB,
            p.feeAmountB
        );
    }

    function payFeesAndBurn(
        Data.FeeContext memory feeCtx,
        address token,
        uint totalAmount
        )
        internal
        view
        returns (uint)
    {
        if (totalAmount == 0) {
            return 0;
        }

        uint amount = totalAmount;
        // No need to pay any fees in a P2P order without a wallet
        // (but the fee amount is a part of amountS of the order, so the fee amount is rebated).
        if (feeCtx.P2P && feeCtx.wallet == 0x0) {
            amount = 0;
        }

        uint feeToWallet = 0;
        uint minerFee = 0;
        uint minerFeeBurn = 0;
        uint walletFeeBurn = 0;
        if (amount > 0) {
            feeToWallet = amount.mul(feeCtx.walletPercentage) / 100;
            minerFee = amount - feeToWallet;

            // Miner can waive fees for this order. If waiveFeePercentage > 0 this is a simple reduction in fees.
            if (feeCtx.waiveFeePercentage > 0) {
                minerFee = minerFee.mul(
                    feeCtx.ctx.feePercentageBase - uint(feeCtx.waiveFeePercentage)) /
                    feeCtx.ctx.feePercentageBase;
            } else if (feeCtx.waiveFeePercentage < 0) {
                // No fees need to be paid by this order
                minerFee = 0;
            }

            uint32 burnRate = getBurnRate(feeCtx, token);

            // Miner fee
            minerFeeBurn = minerFee.mul(burnRate) / feeCtx.ctx.feePercentageBase;
            minerFee = minerFee - minerFeeBurn;
            // Wallet fee
            walletFeeBurn = feeToWallet.mul(burnRate) / feeCtx.ctx.feePercentageBase;
            feeToWallet = feeToWallet - walletFeeBurn;

            // Pay the wallet
            feeCtx.ctx.feePtr = addFeePayment(
                feeCtx.ctx.feeData,
                feeCtx.ctx.feePtr,
                token,
                feeCtx.wallet,
                feeToWallet
            );

            // Pay the burn rate with the feeHolder as owner
            feeCtx.ctx.feePtr = addFeePayment(
                feeCtx.ctx.feeData,
                feeCtx.ctx.feePtr,
                token,
                address(feeCtx.ctx.feeHolder),
                minerFeeBurn + walletFeeBurn
            );

            // Fees can be paid out in different tokens so we can't easily accumulate the total fee
            // that needs to be paid out to order owners. So we pay out each part out here to all
            // orders that need it.
            uint feeToMiner = minerFee;
            if (feeCtx.ring.minerFeesToOrdersPercentage > 0 && minerFee > 0) {
                // Pay out the fees to the orders
                distributeMinerFeeToOwners(
                    feeCtx,
                    token,
                    minerFee
                );
                // Subtract all fees the miner pays to the orders
                feeToMiner = minerFee.mul(feeCtx.ctx.feePercentageBase -
                    feeCtx.ring.minerFeesToOrdersPercentage) /
                    feeCtx.ctx.feePercentageBase;
            }

            // Pay the miner
            feeCtx.ctx.feePtr = addFeePayment(
                feeCtx.ctx.feeData,
                feeCtx.ctx.feePtr,
                token,
                feeCtx.feeRecipient,
                feeToMiner
            );
        }

        // Calculate the total fee payment after possible discounts (burn rebate + fee waiving)
        // and return the total rebate
        return totalAmount.sub((feeToWallet + minerFee) + (minerFeeBurn + walletFeeBurn));
    }

    function getBurnRate(
        Data.FeeContext memory feeCtx,
        address token
        )
        internal
        view
        returns (uint32)
    {
        bytes32[] memory tokenBurnRates = feeCtx.ctx.tokenBurnRates;
        uint length = tokenBurnRates.length;
        for (uint i = 0; i < length; i += 2) {
            if (token == address(tokenBurnRates[i])) {
                uint32 burnRate = uint32(tokenBurnRates[i + 1]);
                return feeCtx.P2P ? (burnRate / 0x10000) : (burnRate & 0xFFFF);
            }
        }
        // Not found, add it to the list
        uint32 burnRate = feeCtx.ctx.burnRateTable.getBurnRate(token);
        assembly {
            let ptr := add(tokenBurnRates, mul(add(1, length), 32))
            mstore(ptr, token)                              // token
            mstore(add(ptr, 32), burnRate)                  // burn rate
            mstore(tokenBurnRates, add(length, 2))          // length
        }
        return feeCtx.P2P ? (burnRate / 0x10000) : (burnRate & 0xFFFF);
    }

    function distributeMinerFeeToOwners(
        Data.FeeContext memory feeCtx,
        address token,
        uint minerFee
        )
        internal
        pure
    {
        for (uint i = 0; i < feeCtx.ring.size; i++) {
            if (feeCtx.ring.participations[i].order.waiveFeePercentage < 0) {
                uint feeToOwner = minerFee
                    .mul(uint(-feeCtx.ring.participations[i].order.waiveFeePercentage)) / feeCtx.ctx.feePercentageBase;

                feeCtx.ctx.feePtr = addFeePayment(
                    feeCtx.ctx.feeData,
                    feeCtx.ctx.feePtr,
                    token,
                    feeCtx.ring.participations[i].order.owner,
                    feeToOwner);
            }
        }
    }

    function addFeePayment(
        uint data,
        uint ptr,
        address token,
        address owner,
        uint amount
        )
        internal
        pure
        returns (uint)
    {
        if (amount == 0) {
            return ptr;
        } else {
            assembly {
                // Try to find an existing fee payment of the same token to the same owner
                let addNew := 1
                for { let p := data } lt(p, ptr) { p := add(p, 96) } {
                    let dataToken := mload(add(p,  0))
                    let dataOwner := mload(add(p, 32))
                    // if(token == dataToken && owner == dataOwner)
                    if and(eq(token, dataToken), eq(owner, dataOwner)) {
                        let dataAmount := mload(add(p, 64))
                        // dataAmount = amount.add(dataAmount);
                        dataAmount := add(amount, dataAmount)
                        // require(dataAmount > amount) (safe math)
                        if sub(1, gt(dataAmount, amount)) {
                            revert(0, 0)
                        }
                        mstore(add(p, 64), dataAmount)
                        addNew := 0
                        // End the loop
                        p := ptr
                    }
                }
                // Add a new fee payment
                if eq(addNew, 1) {
                    mstore(add(ptr,  0), token)
                    mstore(add(ptr, 32), owner)
                    mstore(add(ptr, 64), amount)
                    ptr := add(ptr, 96)
                }
            }
            return ptr;
        }
    }

}
