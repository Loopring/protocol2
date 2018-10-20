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

import "../helper/OrderHelper.sol";
import "../iface/IOrderBook.sol";
import "../impl/Data.sol";
import "../lib/NoDefaultFunc.sol";


/// @title An Implementation of IOrderbook.
/// @author Daniel Wang - <daniel@loopring.org>.
/// @author Kongliang Zhong - <kongliang@loopring.org>.
contract OrderBook is IOrderBook, NoDefaultFunc {
    using OrderHelper     for Data.Order;

    function submitOrder(
        bytes32[] dataArray
        )
        external
        returns (bytes32)
    {
        require(dataArray.length >= 17, INVALID_SIZE);
        bool allOrNone = false;
        if (uint(dataArray[16]) > 0) {
            allOrNone = true;
        }

        /// msg.sender must be order's owner or broker.
        /// no need to check order's broker is registered here. it will be checked during
        /// ring settlement.
        require(
            msg.sender == address(dataArray[0]) || msg.sender == address(dataArray[6]),
            UNAUTHORIZED_ONCHAIN_ORDER
        );

        Data.Order memory order = Data.Order(
            0,                     // version
            address(dataArray[0]), // owner
            address(dataArray[1]), // tokenS
            address(dataArray[2]), // tokenB
            uint(dataArray[3]), // amountS
            uint(dataArray[4]), // amountB
            uint(dataArray[5]), // validSince
            Data.Spendable(true, 0, 0),
            Data.Spendable(true, 0, 0),
            0x0,
            address(dataArray[6]), // broker
            Data.Spendable(true, 0, 0),
            Data.Spendable(true, 0, 0),
            address(dataArray[7]), // orderInterceptor
            address(dataArray[8]), // wallet
            uint(dataArray[9]), // validUtil
            new bytes(0),
            new bytes(0),
            allOrNone,
            address(dataArray[10]), // feeToken
            uint(dataArray[11]), // feeAmount
            0,
            uint16(dataArray[12]), // tokenSFeePercentage
            uint16(dataArray[13]), // tokenBFeePercentage
            address(dataArray[14]), // tokenRecipient
            uint16(dataArray[15]), // walletSplitPercentage
            false,
            bytes32(0x0),
            0x0,
            0,
            0,
            true,
            Data.TokenType.ERC20,
            Data.TokenType.ERC20,
            Data.TokenType.ERC20,
            0x0,
            0x0,
            new bytes(0)
        );

        order.updateHash();
        require(!orderSubmitted[order.hash], ALREADY_EXIST);

        orderSubmitted[order.hash] = true;
        orders[order.hash] = dataArray;
        emit OrderSubmitted(msg.sender, order.hash);
        return order.hash;
    }

    function getOrderData(
        bytes32 orderHash
        )
        external
        view
        returns (bytes32[])
    {
        return orders[orderHash];
    }

}
