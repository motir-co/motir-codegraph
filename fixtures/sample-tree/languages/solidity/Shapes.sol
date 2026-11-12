pragma solidity ^0.8.0;

import "./Shape.sol";

contract Circle is Shape {
    function area() public view returns (uint256) {
        return square(radius);
    }
}
