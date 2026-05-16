// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

/// @title MockBaseL1StandardBridge
/// @notice Stand-in for Base's real `L1StandardBridge.bridgeERC20To`. The real
///         bridge emits the same event and queues the deposit for delivery to
///         Base L2 (~3 minutes); here we just keep the tokens and emit so the
///         demo can prove the depositor->recipient link is broken at this hop.
contract MockBaseL1StandardBridge {
    event ERC20BridgeInitiated(
        address indexed l1Token,
        address indexed l2Token,
        address indexed from,
        address to,
        uint256 amount,
        bytes extraData
    );

    /// @notice Pulls `_amount` of `_l1Token` from `msg.sender` and emits the
    ///         bridge-initiated event. Mirrors the Base L1StandardBridge ABI.
    function bridgeERC20To(
        address _l1Token,
        address _l2Token,
        address _to,
        uint256 _amount,
        uint32, /* _minGasLimit */
        bytes calldata _extraData
    ) external {
        require(
            IERC20(_l1Token).transferFrom(msg.sender, address(this), _amount),
            "transferFrom failed"
        );
        emit ERC20BridgeInitiated(_l1Token, _l2Token, msg.sender, _to, _amount, _extraData);
    }
}
