pragma solidity ^0.5.0;

interface IOwnerRole {
    function isOwner (address _owner) external view returns (bool);
}
