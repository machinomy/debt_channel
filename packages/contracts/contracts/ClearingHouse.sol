pragma solidity ^0.5.0;

import "openzeppelin-solidity/contracts/math/SafeMath.sol";
import "openzeppelin-solidity/contracts/cryptography/ECDSA.sol";
import "./Holding.sol";


/// @title Clearing House
contract ClearingHouse {
    using SafeMath for uint256;

    mapping (address => mapping (bytes32 => bool)) public cleared;

    function clear (
        address payable _partyA,
        address payable _partyB,
        bytes32 _idA,
        bytes32 _idB,
        bytes memory _sigA,
        bytes memory _sigB) public
    {
        Holding holdingA = Holding(_partyA);
        bytes32 digestA = ECDSA.toEthSignedMessageHash(clearDigest(_partyA, _partyB, _idA, _idB));
        address recoveredA = ECDSA.recover(digestA, _sigA);
        require(holdingA.isSigner(recoveredA), "clear: Wrong signature party A");

        Holding holdingB = Holding(_partyB);
        bytes32 digestB = ECDSA.toEthSignedMessageHash(clearDigest(_partyA, _partyB, _idA, _idB));
        address recoveredB = ECDSA.recover(digestB, _sigB);
        require(holdingB.isSigner(recoveredB), "clear: Wrong signature party B");

        cleared[_partyA][_idA] = true;
        cleared[_partyB][_idB] = true;
    }

    function isCleared (address _party, bytes32 _id) public view returns (bool) {
        return cleared[_party][_id];
    }

    function forgive (bytes32 _id) public {
        cleared[msg.sender][_id] = true;
    }

    function clearDigest (address _partyA, address _partyB, bytes32 _idA, bytes32 _idB) public pure returns (bytes32) {
        return keccak256(abi.encode("cl", _partyA, _partyB, _idA, _idB));
    }
}
