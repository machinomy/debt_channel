pragma solidity ^0.5.0;

import "openzeppelin-solidity/contracts/access/Roles.sol";
import "openzeppelin-solidity/contracts/cryptography/ECDSA.sol";
import "../Holding.sol";

contract SignerRole {
    using Roles for Roles.Role;

    event SignerAdded(address indexed account);
    event SignerRemoved(address indexed account);

    Roles.Role private _signers;

    Holding parentContract;

    constructor (Holding _parentContract) internal {
        parentContract = _parentContract;
        _signers.add(msg.sender);
    }

    modifier onlySigner() {
        require(isSigner(msg.sender));
        _;
    }

    function isSigner(address account) public view returns (bool) {
        return _signers.has(account);
    }

    function addSignerDigest (address _newSigner) public view returns (bytes32) {
        return keccak256(abi.encode("as", address(parentContract), _newSigner));
    }

    function removeSignerDigest (address _signer) public view returns (bytes32) {
        return keccak256(abi.encode("rs", address(parentContract), _signer));
    }

    function addSigner (address _newSigner, bytes memory _signature) public {
        bytes32 digest = ECDSA.toEthSignedMessageHash(addSignerDigest(_newSigner));
        address owner = ECDSA.recover(digest, _signature);
        require(parentContract.isOwner(owner), "addSigner: Should be signed by one of owners");
        _signers.add(_newSigner);
        emit SignerAdded(_newSigner);
    }

    function removeSigner (address _signer, bytes memory _signature) public {
        bytes32 digest = ECDSA.toEthSignedMessageHash(removeSignerDigest(_signer));
        address owner = ECDSA.recover(digest, _signature);
        require(parentContract.isOwner(owner), "removeSigner: Should be signed by one of owners");
        _signers.remove(_signer);
        emit SignerRemoved(_signer);
    }
}
