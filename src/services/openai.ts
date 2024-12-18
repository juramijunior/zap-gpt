import OpenAI from "openai";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import fetch from "node-fetch"; // Para baixar o áudio
import { Readable } from "stream";
import fs from "fs";
import path from "path";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // Certifique-se de definir sua API Key no .env
});

export const getOpenAiCompletion = async (input: string): Promise<string> => {
  try {
    const temperature = 0.0; // Reduzido para zero para respostas determinísticas
    const maxTokens = 200; // Limitar o tamanho da resposta
    const model = process.env.OPENAI_FINE_TUNED_MODEL || "gpt-3.5-turbo"; // Usa modelo treinado, se definido

    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `
Você é um assistente especializado em nutrição materno-infantil da Dra. Sabrina.

INSTRUÇÕES IMPORTANTES:
1. **Responda apenas com base nos exemplos de treinamento fornecidos e nas instruções deste prompt.** Não invente ou assuma informações não fornecidas.
2. Se o usuário fizer uma pergunta que não tenha resposta no treinamento ou instruções fornecidas, responda com: 
   "Desculpe, não possuo essa informação no momento. Entre em contato com a Dra. Sabrina para mais detalhes."
3. Caso o usuário pergunte sobre qualquer convênio, responda que A Dra. Sabrina atende os convênios Amil e SulAmérica e explique sobre a modalidade de reembolso e nota fiscal, conforme o treinamento.
4. Mantenha a resposta simples, objetiva e no estilo amigável, com emojis usados nos exemplos de treinamento.
5. Nunca tente adivinhar ou gerar informações além do que foi fornecido.
6. Caso o usuário pergunte sobre o endereço responda que O Consultório de Nutrição Materno Infantil\nQuadra 205, Lt 01, 7° And. SALA 708 Ed. Quartier Center. Águas Claras Sul\nlocalização: https://maps.google.com/?q=-15.8424,-48.0222\nComo o consultório não conta com recepcionista, a Dra pede que você entre e fique a vontade na recepção, no horário da sua consulta ela te chama, ok? 😉💚".
7. Caso a dúvida envolva valores ou convênios, responda de forma clara e consistente com o treinamento: 
   - "A Dra. Sabrina atende os convênios Amil e SulAmérica."
   - "O valor da consulta avulsa é R$350 reais." 
   - Para outros convênios, explique sobre reembolso e nota fiscal.
          `,
        }, // Contexto do sistema
        {
          role: "user",
          content: input, // Entrada do usuário
        },
      ],
      model: model,
      temperature: temperature, // Determinístico
      max_tokens: maxTokens, // Limitar resposta
    });

    return completion.choices[0].message?.content as string;
  } catch (error) {
    console.error("Erro ao chamar o modelo da OpenAI:", error);
    throw new Error("Não foi possível receber o texto");
  }
};

export const transcribeAudio = async (audioUrl: string): Promise<string> => {
  try {
    console.log("Baixando o áudio...");
    const audioResponse = await fetch(audioUrl);
    const audioBuffer = await audioResponse.buffer();

    // Caminhos dos arquivos temporários
    const tempDir = path.resolve("temp");
    const inputPath = path.join(tempDir, "input.ogg");
    const outputPath = path.join(tempDir, "output.mp3");

    // Cria o diretório 'temp' se ele não existir
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    fs.writeFileSync(inputPath, audioBuffer);

    console.log("Convertendo o áudio para MP3...");
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .setFfmpegPath(ffmpegStatic as string)
        .input(inputPath)
        .audioCodec("libmp3lame")
        .toFormat("mp3")
        .on("end", () => resolve()) // Função vazia que respeita o tipo `() => void`
        .on("error", (error) => reject(error))
        .save(outputPath);
    });

    // Transcrição com Whisper
    console.log("Transcrevendo o áudio...");
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(outputPath) as any,
      model: "whisper-1",
      language: "pt",
    });

    // Limpa os arquivos temporários
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

    console.log("Transcrição concluída:", transcription.text);
    return transcription.text;
  } catch (error) {
    console.error("Erro ao transcrever o áudio:", error);
    throw new Error("Não foi possível processar o áudio enviado.");
  }
};
