import { parentPort, workerData } from 'node:worker_threads';
import { extractResumeText } from './extract';
import { WORKER_READY } from './extract-runner';
import type { ResumeKind } from './sniff';

// Entrada da worker thread de `extractInWorker`: lê um arquivo e devolve o resultado por mensagem.
// Quando esta linha executa os imports acima (pdf.js, mammoth) já foram carregados: é a partir deste
// aviso que o relógio de leitura conta do outro lado.
parentPort!.postMessage(WORKER_READY);
const { buf, kind } = workerData as { buf: Uint8Array; kind: ResumeKind };
parentPort!.postMessage(await extractResumeText(buf, kind));
