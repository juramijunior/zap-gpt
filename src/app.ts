import "dotenv/config";
import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { sendWhatsappMessage } from "./services/twilio";
import { error } from "console";

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("ok");
});

app.post("/chat/send", async (req, res) => {
  const { to, body } = req.body;
  try {
    await sendWhatsappMessage(`whatsapp:${to}`, body);
    res.status(200).json({ sucess: true, body });
  } catch {
    res.status(500).json({ sucess: false, error });
  }
});

app.listen(port, () => console.log(`servidor rodando em ${port}`));
