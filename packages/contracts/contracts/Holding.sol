pragma solidity ^0.5.0;

import "openzeppelin-solidity/contracts/token/ERC20/IERC20.sol";
import "openzeppelin-solidity/contracts/math/SafeMath.sol";
import "openzeppelin-solidity/contracts/cryptography/ECDSA.sol";
import "./vendor/Ownable.sol";
import "./vendor/SignerRole.sol";
import "./ClearingHouse.sol";


/// @title Holding
contract Holding is SignerRole, OwnerRole {
    using SafeMath for uint16;
    using SafeMath for uint256;

    enum State {
        Active,      // Usual case, all operations are permitted
        Retired,     // End of life of contract state, contract will terminated soon.
        Dismissed    // No new debts could be added. One could only repay the existing debts.
    }

    struct Debt {
        address payable destination;     // Receiver address of debt
        address token;                   // Currency of debt
        uint256 collectionAfter;         // Creditor can claim debt after "collectionAfter" seconds
        uint256 amount;                  // Amount of debt
        uint16  salt;                    // ID of debt
    }

    State public _currentState;
    ClearingHouse public _clearingHouse;
    uint256 public _retiringPeriod;
    uint256 public _retiringUntil;
    uint256 public _debtsSize;
    uint256 public _balanceSize;

    mapping (bytes32 => Debt) public debts;
    // mapping (address of token contract) => (balance in tokens)
    mapping (address => uint256) public balance;

    event DidDeposit(address indexed token, uint256 amount);
    event DidAddDebt(address indexed destination, address indexed token, uint256 amount);
    event DidCollect(address indexed destination, address indexed token, uint256 amount);
    event DidClose(address indexed destination, address indexed token, uint256 amount);
    event DidWithdraw(address indexed destination, address indexed token, uint256 amount);
    event DidForgive(address indexed destination, address indexed token, uint256 amount);
    event DidRetired();
    event DidStop();

    /*** ACTIONS AND CONSTRAINTS ***/

    /// @notice Constructs the new "Holding" contract.
    /// @param retiringPeriod How many time Holding resides in Retire state since retire() method called.
    /// @param clearingHouse Address of contract that available to clear debts.
    constructor (uint256 retiringPeriod, ClearingHouse clearingHouse) public SignerRole(this) {
        _retiringPeriod = retiringPeriod;
        _retiringUntil = 0;
        _clearingHouse = clearingHouse;
        _currentState = State.Active;
        _debtsSize = 0;
    }

    function () external payable {
        if (balance[address(0x0)] == 0) {
            _balanceSize = _balanceSize.add(1);
        }

        balance[address(0x0)] = balance[address(0x0)].add(msg.value);

        emit DidDeposit(address(0x0), msg.value);
    }

    /// @notice Get current contract lifecycle stage.
    /// @return { State.Active OR State.Retire OR State.Dismissed
    function currentState () public returns (State) {
        if (_retiringUntil != 0 && block.timestamp >= _retiringUntil) {
            _currentState = State.Dismissed;
        }
        return _currentState;
    }

    /// @notice Prepare contract for termination. Starts a retiring period.
    /// After retiring period no new debts could be added. One could only repay the existing debts.
    /// @param _signature Signature of contract owner
    function retire (bytes memory _signature) public {
        require(currentState() == State.Active, "retire: Must be in Active state");
        bytes32 digest = ECDSA.toEthSignedMessageHash(retireDigest(address(this)));
        address recovered = ECDSA.recover(digest, _signature);
        require(isSigner(recovered), "retire: Should be signed");

        _retiringUntil = block.timestamp + _retiringPeriod;
        _currentState = State.Retired;

        emit DidRetired();
    }

    /// @notice Prepare contract for termination. Starts a retiring period.
    //  After retiring period no new debts could be added. One could only repay the existing debts.
    function stop() public {
        require(currentState() == State.Dismissed, "stop: Must be in Dismissed state");
        require(_debtsSize == 0, "stop: There are some debts exists in contract");
        require(_balanceSize == 0, "stop: Need to have null balances for using stop method");

        emit DidStop();

        selfdestruct(address(msg.sender));

    }

    /// @notice Add deposit with value _amount in currency _token
    /// @param _token Currency of deposit - token address or 0x0 for ETH
    /// @param _amount Value of deposit
    function deposit (address _token, uint256 _amount) public payable {
        if (balance[_token] == 0) {
            _balanceSize = _balanceSize.add(1);
        }

        if (_token == address(0x0)) {
            balance[_token] = balance[_token].add(msg.value);
        } else {
            IERC20 token = IERC20(_token);
            require(token.transferFrom(msg.sender, address(this), _amount), "deposit: Unable to transfer token to the contract");
            balance[_token] = balance[_token].add(_amount);
        }

        emit DidDeposit(_token, _amount);
    }

    /// @notice Transfer _amount of _token to _destination address.
    /// @param _destination Destination of tokens or ETH
    /// @param _token Currency of withdraw - address for token, 0x0 for ETH
    /// @param _amount Value of withdraw
    /// @param _signature Signature of contract owner (debtor) of withdrawDigest
    function withdraw (address payable _destination, address _token, uint256 _amount, bytes memory _signature) public {
        require(_amount <= balance[_token], "withdraw: Trying to withdraw amount which exceeds current balance in specified token");

        bytes32 digest = ECDSA.toEthSignedMessageHash(withdrawDigest(_destination, _token, _amount));
        address recovered = ECDSA.recover(digest, _signature);
        require(isSigner(recovered), "withdraw: Should be signed");

        if (_token == address(0x0)) {
            require(_destination.send(_amount), "withdraw: Can not transfer eth");
        } else {
            IERC20 token = IERC20(_token);
            require(token.transfer(_destination, _amount), "withdraw: Can not transfer token");
        }

        balance[_token] = balance[_token].sub(_amount);

        if (balance[_token] == 0) {
            _balanceSize = _balanceSize.sub(1);
        }

        emit DidWithdraw(_destination, _token, _amount);
    }

    /// @notice Claim the debt from debtor
    /// @param _id ID of debt in debt mapping
    /// @param _signature Signature of debtor of collectDigest
    function collectDebt (bytes32 _id, bytes memory _signature) public {
        Debt memory debt = debts[_id];
        require(debt.collectionAfter != 0, "collectDebt: Debt with specified ID does not found");
        address payable destination = debt.destination;

        address tokenContract = debt.token;
        Holding other = Holding(destination);

        bytes32 digest = ECDSA.toEthSignedMessageHash(collectDigest(tokenContract));
        address recoveredOther = ECDSA.recover(digest, _signature);

        require(other.isSigner(recoveredOther), "collectDebt: Should be signed by other");

        require(debt.collectionAfter <= block.timestamp, "collectDebt: Can only collect existing stuff");
        IERC20 token = IERC20(tokenContract);
        uint256 amountToSend;
        if (debt.amount > balance[tokenContract]) {
            amountToSend = balance[tokenContract];
        } else {
            amountToSend = debt.amount;
            emit DidClose(destination, tokenContract, amountToSend);
        }

        debt.amount = debt.amount.sub(amountToSend);
        balance[tokenContract] = balance[tokenContract].sub(amountToSend);

        require(token.approve(destination, amountToSend), "collectDebt: Can not approve token transfer");
        other.deposit(tokenContract, amountToSend);

        emit DidCollect(destination, tokenContract, balance[tokenContract]);
    }

    /// @notice Add debt to contract
    /// @param _destination Address of creditor
    /// @param _token Currency of debt
    /// @param _amount Value of debt
    /// @param _salt ID of debt between creditor and debtor
    /// @param _settlementPeriod Time in seconds after that creditor can claim to return debt
    /// @param _sigDebtor Signature of debtor
    /// @param _sigCreditor Signature of creditor
    function addDebt (
        address payable _destination,
        address _token,
        uint256 _amount,
        uint16 _salt,
        uint256 _settlementPeriod,
        bytes memory _sigDebtor,
        bytes memory _sigCreditor
    ) public
    {
        require(currentState() != State.Dismissed, "addDebt: Contract is in dismissed state. Can not add new debt");
        bytes32 digest = ECDSA.toEthSignedMessageHash(addDebtDigest(_destination, _token, _amount, _settlementPeriod));
        address recoveredOwner = ECDSA.recover(digest, _sigDebtor);
        require(isSigner(recoveredOwner), "addDebt: Should be signed by owner");

        address recoveredCreditor = ECDSA.recover(digest, _sigCreditor);
        Holding creditor = Holding(_destination);
        require(creditor.isSigner(recoveredCreditor), "addDebt: Should be signed by creditor");

        bytes32 debtID = debtIdentifier(_destination, _token, _salt);

        require(debts[debtID].collectionAfter == 0, "addDebt: Can not override existing");

        debts[debtID] = Debt({
            destination: _destination,
            token: _token,
            amount: _amount,
            collectionAfter: block.timestamp + _settlementPeriod,
            salt: _salt
        });

        _debtsSize = _debtsSize.add(1);

        emit DidAddDebt(_destination, _token, _amount);
    }

    /// @notice Forgive a debt. Can be called by creditor.
    /// @param _id ID of debt in debt mapping
    /// @param _signature Currency of creditor
    function forgiveDebt (bytes32 _id, bytes memory _signature) public {
        Debt memory debt = debts[_id];
        address payable destination = debt.destination;
        address tokenContract = debt.token;
        Holding other = Holding(destination);
        bytes32 digest = ECDSA.toEthSignedMessageHash(forgiveDigest(destination, tokenContract));
        address recoveredOther = ECDSA.recover(digest, _signature);
        require(other.isSigner(recoveredOther), "forgiveDebt: Should be signed by other");

        delete debts[_id];
        _debtsSize -= _debtsSize.sub(1);

        _clearingHouse.forgive(_id);

        emit DidForgive(destination, tokenContract, debt.amount);
    }

    function forgiveDigest (address _destination, address _token) public pure returns (bytes32) {
        return keccak256(abi.encode("fo", _destination, _token));
    }

    function collectDigest (address _token) public pure returns (bytes32) {
        return keccak256(abi.encode("co", _token));
    }

    function withdrawDigest (address _destination, address _token, uint256 _amount) public pure returns (bytes32) {
        return keccak256(abi.encode("wi", _destination, _token, _amount));
    }

    function retireDigest (address contractAddress) public pure returns (bytes32) {
        return keccak256(abi.encode("re", contractAddress));
    }

    function addDebtDigest (
        address _destination,
        address _token,
        uint256 _amount,
        uint256 _settlementPeriod
    ) public pure returns (bytes32)
    {
        return keccak256(abi.encode("ad", _destination, _token, _amount, _settlementPeriod));
    }

    function debtIdentifier (address _destination, address _token, uint16 _salt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), _destination, _token, _salt));
    }
}
