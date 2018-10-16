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

import "../impl/Data.sol";
import "../lib/MathUint.sol";
import "./OrderHelper.sol";


/// @title ParticipationHelper
/// @author Daniel Wang - <daniel@loopring.org>.
library ParticipationHelper {
    using MathUint for uint;
    using OrderHelper for Data.Order;

    function setMaxFillAmounts(
        Data.Participation p,
        Data.Context ctx
        )
        internal
    {
        uint spendableS = p.order.getSpendableS(ctx);
        uint remainingS = p.order.amountS.sub(p.order.filledAmountS);
        p.fillAmountS = (spendableS < remainingS) ? spendableS : remainingS;
        p.fillAmountB = p.fillAmountS.mul(p.order.amountB) / p.order.amountS;
    }

    function calculateFees(
        Data.Participation p,
        Data.Participation prevP,
        Data.Context ctx
        )
        internal
        returns (bool)
    {
        if (p.order.P2P) {
            // Calculate P2P fees
            p.feeAmount = 0;
            p.feeAmountS = p.fillAmountS.mul(p.order.tokenSFeePercentage) / ctx.feePercentageBase;
            p.feeAmountB = p.fillAmountB.mul(p.order.tokenBFeePercentage) / ctx.feePercentageBase;
        } else {
            // Calculate matching fees
            p.feeAmount = p.order.feeAmount.mul(p.fillAmountS) / p.order.amountS;
            p.feeAmountS = 0;
            p.feeAmountB = 0;

            // If feeToken == tokenB AND owner == tokenRecipient, try to pay using fillAmountB

            if (p.order.feeToken == p.order.tokenB &&
                p.order.owner == p.order.tokenRecipient &&
                p.fillAmountB >= p.feeAmount) {
                p.feeAmountB = p.feeAmount;
                p.feeAmount = 0;
            }

            if (p.feeAmount > 0) {
                // We have to pay with tokenB if the owner can't pay the complete feeAmount in feeToken
                // This and subsequent orders could use tokenS to pay fees,
                // so we have to make sure the funds needed for this order cannot be used
                uint spendableFee = p.order.getSpendableFee(ctx);
                if (p.feeAmount > spendableFee) {
                    // Never use a security token to pay fees.
                    if (p.order.tokenTypeB == Data.TokenType.ERC1400) {
                        // Pay the available fee balance
                        p.feeAmount = spendableFee;
                        p.order.reserveAmountFee(p.feeAmount);
                    } else {
                        p.feeAmountB = p.fillAmountB.mul(p.order.feePercentage) / ctx.feePercentageBase;
                        p.feeAmount = 0;
                    }
                } else {
                    p.order.reserveAmountFee(p.feeAmount);
                }
            }
        }

        if ((p.fillAmountS - p.feeAmountS) >= prevP.fillAmountB) {
            // The miner (or in a P2P case, the taker) gets the margin
            // Don't pay out the margin to the miner if it's a security token
            if (p.order.tokenTypeS != Data.TokenType.ERC1400) {
                p.splitS = (p.fillAmountS - p.feeAmountS) - prevP.fillAmountB;
            } else {
                p.splitS = 0;
            }
            p.fillAmountS = prevP.fillAmountB + p.feeAmountS;
            return true;
        } else {
            return false;
        }
    }

    function adjustOrderState(
        Data.Participation p
        )
        internal
        pure
    {
        // Update filled amount
        p.order.filledAmountS += p.fillAmountS + p.splitS;

        // Update spendables
        uint totalAmountS = p.fillAmountS + p.splitS;
        uint totalAmountFee = p.feeAmount;
        p.order.tokenSpendableS.amount = p.order.tokenSpendableS.amount.sub(totalAmountS);
        p.order.tokenSpendableFee.amount = p.order.tokenSpendableFee.amount.sub(totalAmountFee);
        if (p.order.brokerInterceptor != 0x0) {
            p.order.brokerSpendableS.amount = p.order.brokerSpendableS.amount.sub(totalAmountS);
            p.order.brokerSpendableFee.amount = p.order.brokerSpendableFee.amount.sub(totalAmountFee);
        }
    }

    function revertOrderState(
        Data.Participation p
        )
        internal
        pure
    {
        // Revert filled amount
        p.order.filledAmountS = p.order.filledAmountS.sub(p.fillAmountS + p.splitS);

        // We do not revert any spendables. Rings will not get rebalanced so this doesn't matter.
    }

}
