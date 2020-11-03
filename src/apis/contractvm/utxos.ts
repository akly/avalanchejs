/**
 * @packageDocumentation
 * @module API-ContractVM-UTXOs
 */
import { Buffer } from 'buffer/';
import BinTools from '../../utils/bintools';
import BN from "bn.js";
import { AmountOutput, SelectOutputClass, TransferableOutput, SECPOwnerOutput, ParseableOutput, StakeableLockOut, SECPTransferOutput } from './outputs';
import { AmountInput, SECPTransferInput, StakeableLockIn, TransferableInput, ParseableInput } from './inputs';
import { UnixNow } from '../../utils/helperfunctions';
import { StandardUTXO, StandardUTXOSet } from '../../common/utxos';
import { ContractVMConstants } from './constants';
import { UnsignedTx } from './tx';
import { ExportTx } from '../contractvm/exporttx';
import { DefaultNetworkID, Defaults } from '../../utils/constants';
import { ImportTx } from '../contractvm/importtx';
import { BaseTx } from '../contractvm/basetx';
import { StandardAssetAmountDestination, AssetAmount } from '../../common/assetamount';
import { Output } from '../../common/output';
import { Serialization, SerializedEncoding } from '../../utils/serialization';

/**
 * @ignore
 */
const bintools = BinTools.getInstance();
const serializer = Serialization.getInstance();

/**
 * Class for representing a single UTXO.
 */
export class UTXO extends StandardUTXO {
  protected _typeName = "UTXO";
  protected _typeID = undefined;

  //serialize is inherited

  deserialize(fields:object, encoding:SerializedEncoding = "hex") {
    super.deserialize(fields, encoding);
    this.output = SelectOutputClass(fields["output"]["_typeID"]);
    this.output.deserialize(fields["output"], encoding);
  }

  fromBuffer(bytes:Buffer, offset:number = 0):number {
    this.codecid = bintools.copyFrom(bytes, offset, offset + 2);
    offset += 2;
    this.txid = bintools.copyFrom(bytes, offset, offset + 32);
    offset += 32;
    this.outputidx = bintools.copyFrom(bytes, offset, offset + 4);
    offset += 4;
    this.assetid = bintools.copyFrom(bytes, offset, offset + 32);
    offset += 32;
    const outputid:number = bintools.copyFrom(bytes, offset, offset + 4).readUInt32BE(0);
    offset += 4;
    this.output = SelectOutputClass(outputid);
    return this.output.fromBuffer(bytes, offset);
  }

  /**
   * Takes a base-58 string containing a [[UTXO]], parses it, populates the class, and returns the length of the StandardUTXO in bytes.
   *
   * @param serialized A base-58 string containing a raw [[UTXO]]
   *
   * @returns The length of the raw [[UTXO]]
   *
   * @remarks
   * unlike most fromStrings, it expects the string to be serialized in cb58 format
   */
  fromString(serialized:string):number {
      /* istanbul ignore next */
      return this.fromBuffer(bintools.cb58Decode(serialized));
  }

  /**
   * Returns a base-58 representation of the [[UTXO]].
   *
   * @remarks
   * unlike most toStrings, this returns in cb58 serialization format
   */
  toString():string {
    /* istanbul ignore next */
    return bintools.cb58Encode(this.toBuffer());
  }

  clone():this {
    const utxo:UTXO = new UTXO();
    utxo.fromBuffer(this.toBuffer());
    return utxo as this;
  }

  create(
    codecID:number = ContractVMConstants.LATESTCODEC, 
    txid:Buffer = undefined,
    outputidx:Buffer | number = undefined,
    assetid:Buffer = undefined,
    output:Output = undefined):this 
  {
    return new UTXO(codecID, txid, outputidx, assetid, output) as this;
  }

}

export class AssetAmountDestination extends StandardAssetAmountDestination<TransferableOutput, TransferableInput> {}

/**
 * Class representing a set of [[UTXO]]s.
 */
export class UTXOSet extends StandardUTXOSet<UTXO>{
  protected _typeName = "UTXOSet";
  protected _typeID = undefined;

  //serialize is inherited

  deserialize(fields:object, encoding:SerializedEncoding = "hex") {
    super.deserialize(fields, encoding);
    let utxos = {};
    for(let utxoid in fields["utxos"]){
      let utxoidCleaned:string = serializer.decoder(utxoid, encoding, "base58", "base58");
      utxos[utxoidCleaned] = new UTXO();
      utxos[utxoidCleaned].deserialize(fields["utxos"][utxoid], encoding);
    }
    let addressUTXOs = {};
    for(let address in fields["addressUTXOs"]){
      let addressCleaned:string = serializer.decoder(address, encoding, "cb58", "hex");
      let utxobalance = {};
      for(let utxoid in fields["addressUTXOs"][address]){
        let utxoidCleaned:string = serializer.decoder(utxoid, encoding, "base58", "base58");
        utxobalance[utxoidCleaned] = serializer.decoder(fields["addressUTXOs"][address][utxoid], encoding, "decimalString", "BN");
      }
      addressUTXOs[addressCleaned] = utxobalance;
    }
    this.utxos = utxos;
    this.addressUTXOs = addressUTXOs;
  }

  parseUTXO(utxo:UTXO | string):UTXO {
    const utxovar:UTXO = new UTXO();
    // force a copy
    if (typeof utxo === 'string') {
      utxovar.fromBuffer(bintools.cb58Decode(utxo));
    } else if (utxo instanceof StandardUTXO) {
      utxovar.fromBuffer(utxo.toBuffer()); // forces a copy
    } else {
      /* istanbul ignore next */
      throw new Error(`Error - UTXO.parseUTXO: utxo parameter is not a UTXO or string: ${utxo}`);
    }
    return utxovar
  }

  create(...args:any[]):this{
    return new UTXOSet() as this;
  }

  clone():this {
    const newset:UTXOSet = this.create();
    const allUTXOs:Array<UTXO> = this.getAllUTXOs();
    newset.addArray(allUTXOs)
    return newset as this;
  }

  _feeCheck(fee:BN, feeAssetID:Buffer):boolean {
    return (typeof fee !== "undefined" && 
      typeof feeAssetID !== "undefined" &&
      fee.gt(new BN(0)) && feeAssetID instanceof Buffer
    );
  }

  getMinimumSpendable = (aad:AssetAmountDestination, asOf:BN = UnixNow(), locktime:BN = new BN(0), threshold:number = 1, stakeable:boolean = false):Error => {
    const utxoArray:Array<UTXO> = this.getAllUTXOs().filter((u) => {
      if(!stakeable && u.getOutput() instanceof StakeableLockOut && (u.getOutput() as StakeableLockOut).getStakeableLocktime().gt(asOf)){
        return false;
      };
      return true;
    });
    const outs:object = {};
    for(let i = 0; i < utxoArray.length && !aad.canComplete(); i++) {
      const u:UTXO = utxoArray[i];
      const assetKey:string = u.getAssetID().toString("hex");
      const fromAddresses:Array<Buffer> = aad.getSenders();
      if(u.getOutput() instanceof AmountOutput && aad.assetExists(assetKey) && u.getOutput().meetsThreshold(fromAddresses, asOf)) {
        const am:AssetAmount = aad.getAssetAmount(assetKey);
        if(!am.isFinished()) {
          const uout:AmountOutput = u.getOutput() as AmountOutput;
          if(!(assetKey in outs)) {
            outs[assetKey] = {
              lockedStakeable:[],
              unlocked:[]
            };
          }
          const amount = uout.getAmount();
          const txid:Buffer = u.getTxID();
          const outputidx:Buffer = u.getOutputIdx();
          let input:AmountInput;
          if(uout instanceof StakeableLockOut) {
            let stakeout:StakeableLockOut = uout as StakeableLockOut;
            let pinput:ParseableInput = new ParseableInput(new SECPTransferInput(amount));
            input = new StakeableLockIn(amount, stakeout.getStakeableLocktime(), pinput);
            am.spendAmount(amount, true);
            outs[assetKey].lockedStakeable.push(uout);
          } else {
            input = new SECPTransferInput(amount);
            am.spendAmount(amount, false);
            outs[assetKey].unlocked.push(uout);
          }

          const xferin:TransferableInput = new TransferableInput(txid, outputidx, u.getAssetID(), input);
          const spenders:Array<Buffer> = uout.getSpenders(fromAddresses, asOf);
          for (let j = 0; j < spenders.length; j++) {
            const idx:number = uout.getAddressIdx(spenders[j]);
            if (idx === -1) {
              /* istanbul ignore next */
              throw new Error('Error - UTXOSet.getMinimumSpendable: no such '
              + `address in output: ${spenders[j]}`);
            }
            xferin.getInput().addSignatureIdx(idx, spenders[j]);
          }
          aad.addInput(xferin);
        } else if(aad.assetExists(assetKey) && !(u.getOutput() instanceof AmountOutput)) {
          /**
           * Leaving the below lines, not simply for posterity, but for clarification.
           * AssetIDs may have mixed OutputTypes. 
           * Some of those OutputTypes may implement AmountOutput.
           * Others may not.
           * Simply continue in this condition.
           */
          /*return new Error('Error - UTXOSet.getMinimumSpendable: outputID does not '
            + `implement AmountOutput: ${u.getOutput().getOutputID}`);*/
            continue;
        }
      }
    }
    if(!aad.canComplete()) {
      return new Error('Error - UTXOSet.getMinimumSpendable: insufficient '
      + 'funds to create the transaction');
    }
    const amounts:Array<AssetAmount> = aad.getAmounts();
    const zero:BN = new BN(0);
    for(let i = 0; i < amounts.length; i++) {
      const assetKey:string = amounts[i].getAssetIDString();
      const change:BN = amounts[i].getChange();
      const stakeableLockedAmount:BN = amounts[i].getStakeableLockSpent();
      const isStakeableLockChange = amounts[i].getStakeableLockChange();
      const unlockedAmount:BN = amounts[i].getSpent().sub(isStakeableLockChange ? stakeableLockedAmount : stakeableLockedAmount.add(change));
      
      if (unlockedAmount.gt(zero) || stakeableLockedAmount.gt(zero) || change.gt(zero)) {
        if(stakeableLockedAmount.gt(zero) || (isStakeableLockChange && change.gt(zero))) {
          let ls:Array<StakeableLockOut> = outs[assetKey].lockedStakeable;
          let schange:BN = isStakeableLockChange ? change : zero.clone();
          for(let j = 0; j < ls.length; j++) {
            let stakeableLocktime:BN = ls[j].getStakeableLocktime();
            let pout:ParseableOutput = ls[j].getTransferableOutput();
            let o:AmountOutput = pout.getOutput() as AmountOutput;
            let spendme:BN = o.getAmount();
            // FYI - You can always guarantee that the last element of the ls array is the one who gives change (if any)
            if(j == ls.length - 1 && schange.gt(zero)) { 
              spendme = spendme.sub(change);
              let schangeNewOut:AmountOutput = SelectOutputClass(
                  o.getOutputID(), 
                  schange, 
                  o.getAddresses(), 
                  o.getLocktime(), 
                  o.getThreshold()
              ) as AmountOutput;
              let schangeOut:StakeableLockOut = SelectOutputClass(
                  ls[j].getOutputID(),
                  schange,  
                  o.getAddresses(), 
                  o.getLocktime(), 
                  o.getThreshold(), 
                  stakeableLocktime, 
                  new ParseableOutput(schangeNewOut)
              ) as StakeableLockOut;
              const xferout:TransferableOutput = new TransferableOutput(amounts[i].getAssetID(), schangeOut);
              aad.addChange(xferout);
            }
            let newout:AmountOutput = SelectOutputClass(
              o.getOutputID(), 
              spendme, 
              o.getAddresses(), 
              o.getLocktime(), 
              o.getThreshold()
            ) as AmountOutput;
            let spendout:StakeableLockOut = SelectOutputClass(
              ls[j].getOutputID(),
              spendme,  
              o.getAddresses(), 
              o.getLocktime(), 
              o.getThreshold(), 
              stakeableLocktime, 
              new ParseableOutput(newout)
            ) as StakeableLockOut;
            const xferout:TransferableOutput = new TransferableOutput(amounts[i].getAssetID(), spendout);
            aad.addOutput(xferout);
          }
        }

        if(unlockedAmount.gt(zero)) {
          let uchange:BN = isStakeableLockChange ? zero.clone() : change;
          if(uchange.gt(zero)) {
            let schangeOut:AmountOutput = new SECPTransferOutput(
              uchange, 
              aad.getChangeAddresses(),
              locktime, 
              threshold
            ) as AmountOutput;
            const xferout:TransferableOutput = new TransferableOutput(amounts[i].getAssetID(), schangeOut);
            aad.addChange(xferout);
          }
          let spendout:AmountOutput;
          spendout = new SECPTransferOutput(
            unlockedAmount, 
            aad.getDestinations(),
            locktime, 
            threshold
          ) as AmountOutput;
          const xferout:TransferableOutput = new TransferableOutput(amounts[i].getAssetID(), spendout);
          aad.addOutput(xferout);
        }
      }
    }
    return undefined;
  }

  /**
   * Creates an [[UnsignedTx]] wrapping a [[BaseTx]]. For more granular control, you may create your own
   * [[UnsignedTx]] wrapping a [[BaseTx]] manually (with their corresponding [[TransferableInput]]s and [[TransferableOutput]]s).
   *
   * @param networkid The number representing NetworkID of the node
   * @param blockchainid The {@link https://github.com/feross/buffer|Buffer} representing the BlockchainID for the transaction
   * @param amount The amount of the asset to be spent in its smallest denomination, represented as {@link https://github.com/indutny/bn.js/|BN}.
   * @param assetID {@link https://github.com/feross/buffer|Buffer} of the asset ID for the UTXO
   * @param toAddresses The addresses to send the funds
   * @param fromAddresses The addresses being used to send the funds from the UTXOs {@link https://github.com/feross/buffer|Buffer}
   * @param changeAddresses Optional. The addresses that can spend the change remaining from the spent UTXOs. Default: toAddresses
   * @param fee Optional. The amount of fees to burn in its smallest denomination, represented as {@link https://github.com/indutny/bn.js/|BN}
   * @param feeAssetID Optional. The assetID of the fees being burned. Default: assetID
   * @param memo Optional. Contains arbitrary data, up to 256 bytes
   * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
   * @param locktime Optional. The locktime field created in the resulting outputs
   * @param threshold Optional. The number of signatures required to spend the funds in the resultant UTXO
   * 
   * @returns An unsigned transaction created from the passed in parameters.
   *
   */
  buildBaseTx = (
    networkid:number,
    blockchainid:Buffer,
    amount:BN,
    assetID:Buffer,
    toAddresses:Array<Buffer>,
    fromAddresses:Array<Buffer>,
    changeAddresses:Array<Buffer> = undefined,
    fee:BN = undefined,
    feeAssetID:Buffer = undefined,
    memo:Buffer = undefined,
    asOf:BN = UnixNow(),
    locktime:BN = new BN(0),
    threshold:number = 1
  ):UnsignedTx => {

    if(threshold > toAddresses.length) {
      /* istanbul ignore next */
      throw new Error(`Error - UTXOSet.buildBaseTx: threshold is greater than number of addresses`);
    }

    if(typeof changeAddresses === "undefined") {
      changeAddresses = toAddresses;
    }

    if(typeof feeAssetID === "undefined") {
      feeAssetID = assetID;
    }

    const zero:BN = new BN(0);
    
    if (amount.eq(zero)) {
      return undefined;
    }

    const aad:AssetAmountDestination = new AssetAmountDestination(toAddresses, fromAddresses, changeAddresses);
    if(assetID.toString("hex") === feeAssetID.toString("hex")){
      aad.addAssetAmount(assetID, amount, fee);
    } else {
      aad.addAssetAmount(assetID, amount, zero);
      if(this._feeCheck(fee, feeAssetID)) {
        aad.addAssetAmount(feeAssetID, zero, fee);
      }
    }

    let ins:Array<TransferableInput> = [];
    let outs:Array<TransferableOutput> = [];
    
    const success:Error = this.getMinimumSpendable(aad, asOf, locktime, threshold);
    if(typeof success === "undefined") {
      ins = aad.getInputs();
      outs = aad.getAllOutputs();
    } else {
      throw success;
    }

    const baseTx:BaseTx = new BaseTx(networkid, blockchainid, outs, ins, memo);
    return new UnsignedTx(baseTx);

  };

  /**
    * Creates an unsigned ImportTx transaction.
    *
    * @param networkid The number representing NetworkID of the node
    * @param blockchainid The {@link https://github.com/feross/buffer|Buffer} representing the BlockchainID for the transaction
    * @param toAddresses The addresses to send the funds
    * @param fromAddresses The addresses being used to send the funds from the UTXOs {@link https://github.com/feross/buffer|Buffer}
    * @param changeAddresses Optional. The addresses that can spend the change remaining from the spent UTXOs. Default: toAddresses
    * @param importIns An array of [[TransferableInput]]s being imported
    * @param sourceChain A {@link https://github.com/feross/buffer|Buffer} for the chainid where the imports are coming from.
    * @param fee Optional. The amount of fees to burn in its smallest denomination, represented as {@link https://github.com/indutny/bn.js/|BN}. Fee will come from the inputs first, if they can.
    * @param feeAssetID Optional. The assetID of the fees being burned. 
    * @param memo Optional contains arbitrary bytes, up to 256 bytes
    * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
    * @param locktime Optional. The locktime field created in the resulting outputs
    * @param threshold Optional. The number of signatures required to spend the funds in the resultant UTXO
    * @returns An unsigned transaction created from the passed in parameters.
    *
    */
   buildImportTx = (
    networkid:number, 
    blockchainid:Buffer,
    toAddresses:Array<Buffer>,
    fromAddresses:Array<Buffer>,
    changeAddresses:Array<Buffer>,
    atomics:Array<UTXO>,
    sourceChain:Buffer = undefined, 
    fee:BN = undefined,
    feeAssetID:Buffer = undefined, 
    memo:Buffer = undefined, 
    asOf:BN = UnixNow(),
    locktime:BN = new BN(0), 
    threshold:number = 1
  ):UnsignedTx => {
    const zero:BN = new BN(0);
    let ins:Array<TransferableInput> = [];
    let outs:Array<TransferableOutput> = [];
    if(typeof fee === "undefined") {
      fee = zero.clone();
    }

    const importIns:Array<TransferableInput> = [];
    let feepaid:BN = new BN(0);
    let feeAssetStr:string = feeAssetID.toString("hex");
    for(let i:number = 0; i < atomics.length; i++) {
      const utxo:UTXO = atomics[i];
      const assetID:Buffer = utxo.getAssetID(); 
      const output:AmountOutput = utxo.getOutput() as AmountOutput;
      let amt:BN = output.getAmount().clone();
      
      let infeeamount = amt.clone();
      let assetStr:string = assetID.toString("hex");
      if(
        typeof feeAssetID !== "undefined" && 
        fee.gt(zero) && 
        feepaid.lt(fee) && 
        assetStr === feeAssetStr
      ) 
      {
        feepaid = feepaid.add(infeeamount);
        if(feepaid.gte(fee)) {
          infeeamount = feepaid.sub(fee);
          feepaid = fee.clone();
        } else {
          infeeamount =  zero.clone();
        }
      }

      const txid:Buffer = utxo.getTxID();
      const outputidx:Buffer = utxo.getOutputIdx();
      const input:SECPTransferInput = new SECPTransferInput(amt);
      const xferin:TransferableInput = new TransferableInput(txid, outputidx, assetID, input);
      const from:Array<Buffer> = output.getAddresses(); 
      const spenders:Array<Buffer> = output.getSpenders(from, asOf);
      for (let j = 0; j < spenders.length; j++) {
        const idx:number = output.getAddressIdx(spenders[j]);
        if (idx === -1) {
          /* istanbul ignore next */
          throw new Error('Error - UTXOSet.buildImportTx: no such '
          + `address in output: ${spenders[j]}`);
        }
        xferin.getInput().addSignatureIdx(idx, spenders[j]);
      }
      importIns.push(xferin);
      //add extra outputs for each amount (calculated from the imported inputs), minus fees
      if(infeeamount.gt(zero)) {
        const spendout:AmountOutput = SelectOutputClass(output.getOutputID(),
          infeeamount, toAddresses, locktime, threshold) as AmountOutput;
        const xferout:TransferableOutput = new TransferableOutput(assetID, spendout);
        outs.push(xferout);
      }
    }
    
    // get remaining fees from the provided addresses
    let feeRemaining:BN = fee.sub(feepaid);
    if(feeRemaining.gt(zero) && this._feeCheck(feeRemaining, feeAssetID)) {
      const aad:AssetAmountDestination = new AssetAmountDestination(toAddresses, fromAddresses, changeAddresses);
      aad.addAssetAmount(feeAssetID, zero, feeRemaining);
      const success:Error = this.getMinimumSpendable(aad, asOf, locktime, threshold);
      if(typeof success === "undefined") {
        ins = aad.getInputs();
        outs = aad.getAllOutputs();
      } else {
        throw success;
      }
    }

    const importTx:ImportTx = new ImportTx(networkid, blockchainid, outs, ins, memo, sourceChain, importIns);
    return new UnsignedTx(importTx);
  };

  /**
    * Creates an unsigned ExportTx transaction. 
    *
    * @param networkid The number representing NetworkID of the node
    * @param blockchainid The {@link https://github.com/feross/buffer|Buffer} representing the BlockchainID for the transaction
    * @param amount The amount being exported as a {@link https://github.com/indutny/bn.js/|BN}
    * @param avaxAssetID {@link https://github.com/feross/buffer|Buffer} of the asset ID for AVAX
    * @param toAddresses An array of addresses as {@link https://github.com/feross/buffer|Buffer} who recieves the AVAX
    * @param fromAddresses An array of addresses as {@link https://github.com/feross/buffer|Buffer} who owns the AVAX
    * @param changeAddresses An array of addresses as {@link https://github.com/feross/buffer|Buffer} who gets the change leftover of the AVAX
    * @param destinationChain Optional. A {@link https://github.com/feross/buffer|Buffer} for the chainid where to send the asset.
    * @param fee Optional. The amount of fees to burn in its smallest denomination, represented as {@link https://github.com/indutny/bn.js/|BN}
    * @param feeAssetID Optional. The assetID of the fees being burned. 
    * @param memo Optional contains arbitrary bytes, up to 256 bytes
    * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
    * @param locktime Optional. The locktime field created in the resulting outputs
    * @param threshold Optional. The number of signatures required to spend the funds in the resultant UTXO
    * 
    * @returns An unsigned transaction created from the passed in parameters.
    *
    */
   buildExportTx = (
    networkid:number, 
    blockchainid:Buffer,
    amount:BN,
    avaxAssetID:Buffer,
    toAddresses:Array<Buffer>,
    fromAddresses:Array<Buffer>,
    changeAddresses:Array<Buffer> = undefined,
    destinationChain:Buffer = undefined,
    fee:BN = undefined,
    feeAssetID:Buffer = undefined, 
    memo:Buffer = undefined, 
    asOf:BN = UnixNow(),
    locktime:BN = new BN(0), 
    threshold:number = 1,
  ):UnsignedTx => {
    let ins:Array<TransferableInput> = [];
    let outs:Array<TransferableOutput> = [];
    let exportouts:Array<TransferableOutput> = [];
    
    if(typeof changeAddresses === "undefined") {
      changeAddresses = toAddresses;
    }

    const zero:BN = new BN(0);
    
    if (amount.eq(zero)) {
      return undefined;
    }

    if(typeof feeAssetID === "undefined") {
      feeAssetID = avaxAssetID;
    } else if (feeAssetID.toString("hex") !== avaxAssetID.toString("hex")) {
      /* istanbul ignore next */
      throw new Error('Error - UTXOSet.buildExportTx: '
      + `feeAssetID must match avaxAssetID`);
    }

    if(typeof destinationChain === "undefined") {
      destinationChain = bintools.cb58Decode(Defaults.network[networkid].X["blockchainID"]);
    }

    const aad:AssetAmountDestination = new AssetAmountDestination(toAddresses, fromAddresses, changeAddresses);
    if(avaxAssetID.toString("hex") === feeAssetID.toString("hex")){
      aad.addAssetAmount(avaxAssetID, amount, fee);
    } else {
      aad.addAssetAmount(avaxAssetID, amount, zero);
      if(this._feeCheck(fee, feeAssetID)){
        aad.addAssetAmount(feeAssetID, zero, fee);
      }
    }

    const success:Error = this.getMinimumSpendable(aad, asOf, locktime, threshold);
    if(typeof success === "undefined") {
      ins = aad.getInputs();
      outs = aad.getChangeOutputs();
      exportouts = aad.getOutputs();
    } else {
      throw success;
    }

    const exportTx:ExportTx = new ExportTx(networkid, blockchainid, outs, ins, memo, destinationChain, exportouts);
    
    return new UnsignedTx(exportTx);
  };
}
