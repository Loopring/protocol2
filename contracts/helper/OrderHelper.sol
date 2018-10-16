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

import "../impl/BrokerInterceptorProxy.sol";
import "../impl/Data.sol";
import "../lib/ERC1400.sol";
import "../lib/ERC20.sol";
import "../lib/MathUint.sol";
import "../lib/MultihashUtil.sol";


/// @title OrderHelper
/// @author Daniel Wang - <daniel@loopring.org>.
library OrderHelper {
    using MathUint      for uint;
    using BrokerInterceptorProxy for address;

    function updateHash(Data.Order order)
        internal
        pure
    {
        /* order.hash = keccak256( */
        /*     abi.encodePacked( */
        /*         order.amountS, */
        /*         order.amountB, */
        /*         order.feeAmount, */
        /*         order.validSince, */
        /*         order.validUntil, */
        /*         order.owner, */
        /*         order.tokenS, */
        /*         order.tokenB, */
        /*         order.dualAuthAddr, */
        /*         order.broker, */
        /*         order.orderInterceptor, */
        /*         order.wallet, */
        /*         order.tokenRecipient */
        /*         order.feeToken, */
        /*         order.walletSplitPercentage, */
        /*         order.feePercentage, */
        /*         order.tokenSFeePercentage, */
        /*         order.tokenBFeePercentage, */
        /*         order.allOrNone */
        /*     ) */
        /* ); */
        bytes32 hash;
        assembly {
            // Load the free memory pointer
            let ptr := mload(64)

            // We store the members back to front so we can overwrite data for members smaller than 32
            // (mstore always writes 32 bytes)
            mstore(add(ptr, sub(348, 31)), mload(add(order, 576)))   // order.allOrNone
            mstore(add(ptr, sub(346, 30)), mload(add(order, 768)))   // order.tokenBFeePercentage
            mstore(add(ptr, sub(344, 30)), mload(add(order, 736)))   // order.tokenSFeePercentage
            mstore(add(ptr, sub(342, 30)), mload(add(order, 672)))   // order.feePercentage
            mstore(add(ptr, sub(340, 30)), mload(add(order, 832)))   // order.walletSplitPercentage
            mstore(add(ptr, sub(320, 12)), mload(add(order, 608)))   // order.feeToken
            mstore(add(ptr, sub(300, 12)), mload(add(order, 800)))   // order.tokenRecipient
            mstore(add(ptr, sub(280, 12)), mload(add(order, 448)))   // order.wallet
            mstore(add(ptr, sub(260, 12)), mload(add(order, 416)))   // order.orderInterceptor
            mstore(add(ptr, sub(240, 12)), mload(add(order, 320)))   // order.broker
            mstore(add(ptr, sub(220, 12)), mload(add(order, 288)))   // order.dualAuthAddr
            mstore(add(ptr, sub(200, 12)), mload(add(order,  96)))   // order.tokenB
            mstore(add(ptr, sub(180, 12)), mload(add(order,  64)))   // order.tokenS
            mstore(add(ptr, sub(160, 12)), mload(add(order,  32)))   // order.owner
            mstore(add(ptr, sub(128,  0)), mload(add(order, 480)))   // order.validUntil
            mstore(add(ptr, sub( 96,  0)), mload(add(order, 192)))   // order.validSince
            mstore(add(ptr, sub( 64,  0)), mload(add(order, 640)))   // order.feeAmount
            mstore(add(ptr, sub( 32,  0)), mload(add(order, 160)))   // order.amountB
            mstore(add(ptr, sub(  0,  0)), mload(add(order, 128)))   // order.amountS

            hash := keccak256(ptr, 349)  // 5*32 + 9*20 + 4*2 + 1*1
        }
        order.hash = hash;
    }

    function updateBrokerAndInterceptor(
        Data.Order order,
        Data.Context ctx
        )
        internal
        view
    {
        if (order.broker == 0x0) {
            order.broker = order.owner;
        } else {
            bool registered;
            (registered, order.brokerInterceptor) = ctx.orderBrokerRegistry.getBroker(
                order.owner,
                order.broker
            );
            order.valid = order.valid && registered;
        }
    }

    function check(
        Data.Order order,
        Data.Context ctx
        )
        internal
        view
    {
        // If the order was already partially filled
        // we don't have to check all of the infos and the signature again
        if(order.filledAmountS == 0) {
            validateAllInfo(order, ctx);
            checkBrokerSignature(order, ctx);
        } else {
            validateUnstableInfo(order, ctx);
        }

        checkP2P(order);
    }

    function validateAllInfo(
        Data.Order order,
        Data.Context ctx
        )
        internal
        view
    {
        bool valid = true;
        valid = valid && (order.version == 0); // unsupported order version
        valid = valid && (order.owner != 0x0); // invalid order owner
        valid = valid && (order.tokenS != 0x0); // invalid order tokenS
        valid = valid && (order.tokenB != 0x0); // invalid order tokenB
        valid = valid && (order.amountS != 0); // invalid order amountS
        valid = valid && (order.amountB != 0); // invalid order amountB
        valid = valid && (order.feeToken != 0x0); // invalid fee token
        valid = valid && (order.tokenTypeFee != Data.TokenType.ERC1400); // Never pay fees in a security token
        valid = valid && (order.feePercentage < ctx.feePercentageBase); // invalid fee percentage

        valid = valid && (order.tokenSFeePercentage < ctx.feePercentageBase); // invalid tokenS percentage
        valid = valid && !(order.tokenSFeePercentage > 0 && order.tokenTypeS == Data.TokenType.ERC1400);
        valid = valid && (order.tokenBFeePercentage < ctx.feePercentageBase); // invalid tokenB percentage
        valid = valid && !(order.tokenBFeePercentage > 0 && order.tokenTypeB == Data.TokenType.ERC1400);
        valid = valid && (order.walletSplitPercentage <= 100); // invalid wallet split percentage

        valid = valid && (order.validSince <= now); // order is too early to match

        order.valid = order.valid && valid;

        validateUnstableInfo(order, ctx);
    }


    function validateUnstableInfo(
        Data.Order order,
        Data.Context ctx
        )
        internal
        view
    {
        bool valid = true;
        valid = valid && (order.validUntil == 0 || order.validUntil > now);  // order is expired
        valid = valid && (order.waiveFeePercentage <= int16(ctx.feePercentageBase)); // invalid waive percentage
        valid = valid && (order.waiveFeePercentage >= -int16(ctx.feePercentageBase)); // invalid waive percentage
        if (order.dualAuthAddr != 0x0) { // if dualAuthAddr exists, dualAuthSig must be exist.
            valid = valid && (order.dualAuthSig.length > 0);
        }
        order.valid = order.valid && valid;
    }


    function checkP2P(
        Data.Order order
        )
        internal
        pure
    {
        order.P2P = (order.tokenSFeePercentage > 0 || order.tokenBFeePercentage > 0);
    }


    function checkBrokerSignature(
        Data.Order order,
        Data.Context ctx
        )
        internal
        view
    {
        if (order.sig.length == 0) {
            bool registered = ctx.orderRegistry.isOrderHashRegistered(
                order.broker,
                order.hash
            );

            if (!registered) {
                order.valid = order.valid && ctx.orderBook.orderSubmitted(order.hash);
            }
        } else {
            order.valid = order.valid && MultihashUtil.verifySignature(
                order.broker,
                order.hash,
                order.sig
            );
        }
    }

    function checkDualAuthSignature(
        Data.Order order,
        bytes32  miningHash
        )
        internal
        pure
    {
        if (order.dualAuthSig.length != 0) {
            order.valid = order.valid && MultihashUtil.verifySignature(
                order.dualAuthAddr,
                miningHash,
                order.dualAuthSig
            );
        }
    }

    function validateAllOrNone(
        Data.Order order
        )
        internal
        pure
    {
        // Check if this order needs to be completely filled
        if(order.allOrNone) {
            order.valid = order.valid && (order.filledAmountS == order.amountS);
        }
    }

    function getSpendableS(
        Data.Order order,
        Data.Context ctx
        )
        internal
        returns (uint)
    {
        return getSpendable(
            ctx.delegate,
            order.tokenTypeS,
            order.trancheS,
            order.tokenS,
            order.owner,
            order.broker,
            order.brokerInterceptor,
            order.tokenSpendableS,
            order.brokerSpendableS
        );
    }

    function getSpendableFee(
        Data.Order order,
        Data.Context ctx
        )
        internal
        returns (uint)
    {
        return getSpendable(
            ctx.delegate,
            order.tokenTypeFee,
            0x0,
            order.feeToken,
            order.owner,
            order.broker,
            order.brokerInterceptor,
            order.tokenSpendableFee,
            order.brokerSpendableFee
        );
    }

    function reserveAmountS(
        Data.Order order,
        uint amount
        )
        internal
        pure
    {
        order.tokenSpendableS.reserved += amount;
        if (order.brokerInterceptor != 0x0) {
            order.brokerSpendableS.reserved += amount;
        }
    }

    function reserveAmountFee(
        Data.Order order,
        uint amount
        )
        internal
        pure
    {
        order.tokenSpendableFee.reserved += amount;
        if (order.brokerInterceptor != 0x0) {
            order.brokerSpendableFee.reserved += amount;
        }
    }

    function resetReservations(
        Data.Order order
        )
        internal
        pure
    {
        order.tokenSpendableS.reserved = 0;
        order.tokenSpendableFee.reserved = 0;
        if (order.brokerInterceptor != 0x0) {
            order.brokerSpendableS.reserved = 0;
            order.brokerSpendableFee.reserved = 0;
        }
    }

    /// @return Amount of ERC20 token that can be spent by this contract.
    function getERC20Spendable(
        ITradeDelegate delegate,
        address tokenAddress,
        address owner
        )
        private
        view
        returns (uint spendable)
    {
        ERC20 token = ERC20(tokenAddress);
        spendable = token.allowance(
            owner,
            address(delegate)
        );
        if (spendable == 0) {
            return;
        }
        uint balance = token.balanceOf(owner);
        spendable = (balance < spendable) ? balance : spendable;
    }

    /// @return Amount of ERC20 token that can be spent by this contract.
    function getERC1400Spendable(
        ITradeDelegate delegate,
        address tokenAddress,
        bytes32 tranche,
        address owner
        )
        private
        view
        returns (uint spendable)
    {
        ERC1400 token = ERC1400(tokenAddress);
        bool isOperator = token.isOperatorForTranche(
            tranche,
            address(delegate),
            owner
        );
        if (isOperator) {
            spendable = token.balanceOfTranche(tranche, owner);
        } else {
            spendable = 0;
        }
    }

    /// @return Amount of ERC20 token that can be spent by the broker
    function getBrokerAllowance(
        address tokenAddress,
        address owner,
        address broker,
        address brokerInterceptor
        )
        private
        returns (uint allowance)
    {
        allowance = brokerInterceptor.getAllowanceSafe(
            owner,
            broker,
            tokenAddress
        );
    }

    function getSpendable(
        ITradeDelegate delegate,
        Data.TokenType tokenType,
        bytes32 tranche,
        address tokenAddress,
        address owner,
        address broker,
        address brokerInterceptor,
        Data.Spendable tokenSpendable,
        Data.Spendable brokerSpendable
        )
        private
        returns (uint spendable)
    {
        if (!tokenSpendable.initialized) {
            if(tokenType == Data.TokenType.ERC20) {
                tokenSpendable.amount = getERC20Spendable(
                    delegate,
                    tokenAddress,
                    owner
                );
            } else if(tokenType == Data.TokenType.ERC1400) {
                tokenSpendable.amount = getERC1400Spendable(
                    delegate,
                    tokenAddress,
                    tranche,
                    owner
                );
            } else {
                assert(false);
            }
            tokenSpendable.initialized = true;
        }
        spendable = tokenSpendable.amount.sub(tokenSpendable.reserved);
        if (brokerInterceptor != 0x0) {
            if (!brokerSpendable.initialized) {
                brokerSpendable.amount = getBrokerAllowance(
                    tokenAddress,
                    owner,
                    broker,
                    brokerInterceptor
                );
                brokerSpendable.initialized = true;
            }
            uint brokerSpendableAmount = brokerSpendable.amount.sub(brokerSpendable.reserved);
            spendable = (brokerSpendableAmount < spendable) ? brokerSpendableAmount : spendable;
        }
    }
}
