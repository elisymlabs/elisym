// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// The few Foundry cheatcodes these tests use. Declared here instead of vendoring
/// forge-std: the repository ignores `build` directories and takes no git submodules.
interface Vm {
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData) external;
}
