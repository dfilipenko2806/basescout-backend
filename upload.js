import axios from "axios";
import FormData from "form-data";

export async function uploadToIPFS(file) {

  const formData = new FormData();

  formData.append("file", file.buffer, {
    filename: file.originalname,
    contentType: file.mimetype
  });

  const res = await axios.post(
    "https://api.pinata.cloud/pinning/pinFileToIPFS",
    formData,
    {
      maxBodyLength: Infinity,
      headers: {
        ...formData.getHeaders(),
        Authorization: `Bearer ${process.env.PINATA_JWT}`
      }
    }
  );

  const hash = res.data.IpfsHash;

  return `https://gateway.pinata.cloud/ipfs/${hash}`;
}