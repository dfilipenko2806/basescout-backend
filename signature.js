// signature.js
import { ethers } from "ethers";

export function verifySignature(message, signature, address) {
  try {
    const recovered = ethers.verifyMessage(message, signature);
    return recovered.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}
