// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ElisymConfig} from "../src/ElisymConfig.sol";
import {Vm} from "./Vm.sol";

contract ElisymConfigTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant OWNER = address(0xA11CE);
    address private constant TREASURY = address(0x7EA5);
    address private constant SUCCESSOR = address(0xB0B);
    address private constant STRANGER = address(0xBAD);

    ElisymConfig private config;

    event OwnerProposed(address indexed owner, address indexed proposed);
    event OwnerAccepted(address indexed previousOwner, address indexed owner);
    event PendingOwnerCancelled(address indexed cancelled);
    event FeeBpsSet(uint16 previousFeeBps, uint16 feeBps);
    event TreasurySet(address indexed previousTreasury, address indexed treasury);

    function setUp() public {
        config = new ElisymConfig(OWNER, TREASURY, 0);
    }

    function check(bool condition, string memory what) private pure {
        require(condition, what);
    }

    function test_constructor_sets_everything_and_reads_in_one_call() public view {
        (uint16 feeBps, address treasury) = config.config();
        check(feeBps == 0 && treasury == TREASURY, "config()");
        check(config.owner() == OWNER, "owner");
        check(config.pendingOwner() == address(0), "pendingOwner");
        check(config.MAX_FEE_BPS() == 1000, "cap");
    }

    function test_constructor_refuses_a_zero_owner() public {
        VM.expectRevert(ElisymConfig.ZeroAddress.selector);
        new ElisymConfig(address(0), TREASURY, 0);
    }

    function test_constructor_refuses_a_zero_treasury() public {
        VM.expectRevert(ElisymConfig.ZeroAddress.selector);
        new ElisymConfig(OWNER, address(0), 0);
    }

    function test_constructor_refuses_a_fee_above_the_cap() public {
        VM.expectRevert(ElisymConfig.FeeTooHigh.selector);
        new ElisymConfig(OWNER, TREASURY, 1001);
    }

    function test_owner_sets_the_fee_up_to_the_cap() public {
        VM.expectEmit(false, false, false, true);
        emit FeeBpsSet(0, 1000);
        VM.prank(OWNER);
        config.setFeeBps(1000);
        check(config.feeBps() == 1000, "fee at the cap");
    }

    function test_fee_above_the_cap_is_refused() public {
        VM.prank(OWNER);
        VM.expectRevert(ElisymConfig.FeeTooHigh.selector);
        config.setFeeBps(1001);
    }

    function test_stranger_cannot_set_the_fee() public {
        VM.prank(STRANGER);
        VM.expectRevert(ElisymConfig.NotOwner.selector);
        config.setFeeBps(1);
    }

    function test_owner_sets_the_treasury() public {
        VM.expectEmit(true, true, false, true);
        emit TreasurySet(TREASURY, SUCCESSOR);
        VM.prank(OWNER);
        config.setTreasury(SUCCESSOR);
        check(config.treasury() == SUCCESSOR, "treasury");
    }

    function test_zero_treasury_is_refused() public {
        VM.prank(OWNER);
        VM.expectRevert(ElisymConfig.ZeroAddress.selector);
        config.setTreasury(address(0));
    }

    function test_stranger_cannot_set_the_treasury() public {
        VM.prank(STRANGER);
        VM.expectRevert(ElisymConfig.NotOwner.selector);
        config.setTreasury(STRANGER);
    }

    function test_handover_takes_two_steps() public {
        VM.expectEmit(true, true, false, true);
        emit OwnerProposed(OWNER, SUCCESSOR);
        VM.prank(OWNER);
        config.proposeOwner(SUCCESSOR);
        check(config.owner() == OWNER, "proposing alone changes nothing");
        check(config.pendingOwner() == SUCCESSOR, "pending");

        VM.expectEmit(true, true, false, true);
        emit OwnerAccepted(OWNER, SUCCESSOR);
        VM.prank(SUCCESSOR);
        config.acceptOwner();
        check(config.owner() == SUCCESSOR, "accepted");
        check(config.pendingOwner() == address(0), "pending cleared");

        VM.prank(OWNER);
        VM.expectRevert(ElisymConfig.NotOwner.selector);
        config.setFeeBps(1);
    }

    function test_only_the_pending_owner_accepts() public {
        VM.prank(OWNER);
        config.proposeOwner(SUCCESSOR);
        VM.prank(STRANGER);
        VM.expectRevert(ElisymConfig.NotPendingOwner.selector);
        config.acceptOwner();
        VM.prank(OWNER);
        VM.expectRevert(ElisymConfig.NotPendingOwner.selector);
        config.acceptOwner();
    }

    function test_nobody_accepts_when_nothing_is_pending() public {
        VM.prank(address(0));
        VM.expectRevert(ElisymConfig.NotPendingOwner.selector);
        config.acceptOwner();
    }

    function test_a_proposal_can_be_cancelled_and_then_cannot_be_accepted() public {
        VM.prank(OWNER);
        config.proposeOwner(SUCCESSOR);
        VM.expectEmit(true, false, false, true);
        emit PendingOwnerCancelled(SUCCESSOR);
        VM.prank(OWNER);
        config.cancelPendingOwner();
        VM.prank(SUCCESSOR);
        VM.expectRevert(ElisymConfig.NotPendingOwner.selector);
        config.acceptOwner();
    }

    function test_stranger_cannot_propose_or_cancel() public {
        VM.prank(STRANGER);
        VM.expectRevert(ElisymConfig.NotOwner.selector);
        config.proposeOwner(STRANGER);
        VM.prank(STRANGER);
        VM.expectRevert(ElisymConfig.NotOwner.selector);
        config.cancelPendingOwner();
    }

    function test_zero_successor_is_refused() public {
        VM.prank(OWNER);
        VM.expectRevert(ElisymConfig.ZeroAddress.selector);
        config.proposeOwner(address(0));
    }

    function testFuzz_fee_is_never_above_the_cap(uint16 requested) public {
        VM.prank(OWNER);
        if (requested > 1000) {
            VM.expectRevert(ElisymConfig.FeeTooHigh.selector);
        }
        config.setFeeBps(requested);
        check(config.feeBps() <= 1000, "cap holds");
    }
}
