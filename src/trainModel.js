import { OpenAI } from "openai";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // Substitua pela sua chave de API no arquivo .env
});

// Função para fazer o upload do arquivo JSONL
async function uploadFile(filePath) {
  try {
    const file = fs.createReadStream(filePath);
    const response = await openai.files.create({
      file,
      purpose: "fine-tune",
    });
    console.log("Arquivo enviado com sucesso. ID:", response.id);
    return response.id; // Retorna o ID do arquivo
  } catch (err) {
    console.error(
      "Erro ao enviar o arquivo:",
      err.response?.data || err.message
    );
    throw err;
  }
}

// Função para iniciar o fine-tuning
async function createFineTune(fileId) {
  try {
    const response = await openai.fineTuning.jobs.create({
      training_file: fileId,
      model: "gpt-3.5-turbo", // Substitua por "gpt-4" se sua conta suportar
    });
    console.log("Treinamento iniciado. ID:", response.id);
    return response.id; // Retorna o ID do fine-tuning
  } catch (err) {
    console.error(
      "Erro ao criar o fine-tune:",
      err.response?.data || err.message
    );
    throw err;
  }
}

// Função para monitorar o treinamento
async function monitorFineTune(fineTuneId) {
  try {
    console.log("Acompanhando o treinamento...");
    const events = await openai.fineTuning.jobs.listEvents(fineTuneId);
    events.data.forEach((event) => {
      console.log(`[${event.created_at}] ${event.message}`);
    });
  } catch (err) {
    console.error(
      "Erro ao acompanhar o fine-tune:",
      err.response?.data || err.message
    );
    throw err;
  }
}

// Fluxo principal
async function main() {
  const filePath =
    "C:/Users/juram/OneDrive/Área de Trabalho/DEV/anonimizador/Conversas_Unificado_Chat_Format.jsonl"; // Caminho do arquivo JSONL
  try {
    // 1. Enviar o arquivo JSONL
    const fileId = await uploadFile(filePath);

    // 2. Iniciar o treinamento
    const fineTuneId = await createFineTune(fileId);

    // 3. Monitorar o progresso do treinamento
    await monitorFineTune(fineTuneId);
  } catch (err) {
    console.error(
      "Erro no processo de treinamento:",
      err.response?.data || err.message
    );
  }
}

main();
