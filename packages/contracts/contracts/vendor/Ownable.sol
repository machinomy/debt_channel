pragma solidity ^0.5.0;

import "openzeppelin-solidity/contracts/access/Roles.sol";
import "openzeppelin-solidity/contracts/access/roles/WhitelistAdminRole.sol";
import "openzeppelin-solidity/contracts/cryptography/ECDSA.sol";

/**
 * @title Ownable
 */
contract Ownable is WhitelistAdminRole {
    function addOwnerDigest (address _newOwner) public view returns (bytes32) {
        return keccak256(abi.encode("ao", address(this), _newOwner));
    }

    function removeOwnerDigest (address _owner) public view returns (bytes32) {
        return keccak256(abi.encode("ro", address(this), _owner));
    }

    function isOwner (address _owner) public view returns (bool) {
        return isWhitelistAdmin(_owner);
    }

    function addOwner (address _newOwner, bytes memory _signature) public {
        bytes32 digest = ECDSA.toEthSignedMessageHash(addOwnerDigest(_newOwner));
        address newOwner = ECDSA.recover(digest, _signature);
        require(isOwner(newOwner), "addOwner: Should be signed by one of owners");
        addWhitelistAdmin(_newOwner);
    }

    function removeOwner (address _owner, bytes memory _signature) public {
        bytes32 digest = ECDSA.toEthSignedMessageHash(removeOwnerDigest(_owner));
        address owner = ECDSA.recover(digest, _signature);
        require(isOwner(owner), "removeOwner: Should be signed by one of owners");
        _removeWhitelistAdmin(_owner);
    }
}
