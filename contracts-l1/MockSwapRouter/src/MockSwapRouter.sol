// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

/// @title MockSwapRouter
/// @notice Drop-in for Uniswap V3's SwapRouter at the mainnet address. Performs a
///         1:1 swap from `tokenIn` to `tokenOut` by pulling tokenIn from the caller
///         and transferring an equal amount of tokenOut from its own balance to the
///         recipient. Pre-fund this contract with tokenOut before swapping.
contract MockSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    event MockSwap(
        address indexed caller,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address recipient
    );

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        returns (uint256 amountOut)
    {
        require(block.timestamp <= params.deadline, "deadline");
        // Pull input tokens from the caller and lock them here.
        require(
            IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn),
            "transferFrom in"
        );
        // 1:1 payout — keep it simple for the mock.
        amountOut = params.amountIn;
        require(amountOut >= params.amountOutMinimum, "slippage");
        require(
            IERC20(params.tokenOut).balanceOf(address(this)) >= amountOut,
            "router underfunded"
        );
        require(IERC20(params.tokenOut).transfer(params.recipient, amountOut), "transfer out");
        emit MockSwap(msg.sender, params.tokenIn, params.tokenOut, params.amountIn, amountOut, params.recipient);
    }
}
