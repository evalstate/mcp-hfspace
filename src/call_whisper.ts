import { Client, handle_file } from "@gradio/client";
import { readFile } from "fs/promises";

async function main() {
    if (process.argv.length < 3) {
        console.error("Please provide an audio file path as argument");
        process.exit(1);
    }

    const audioFile = process.argv[2];

    try {
        // Read file and convert to blob
//        const fileBuffer = await readFile(audioFile);
  //      const audioBlob = new Blob([fileBuffer], { type: 'audio/wav' });
    //    console.log("BLOB READ!");
        const app = await Client.connect("hf-audio/whisper-large-v3", {
            events: ["data", "status"]
        });
//        const handled = handle_file(audioFile);
        const submission = app.submit("/predict", {
            inputs: handle_file(audioFile)
        });

        for await (const msg of submission) {
            if (msg.type === "status") {
                console.log("Status:", JSON.stringify(msg, null, 2));
            }
            if (msg.type === "data") {
                console.log("Transcription:", msg.data);
                break; // Exit after getting the data
            }
        }
    } catch (error) {
        console.error("Error:", error);
        process.exit(1);
    }
}

main();