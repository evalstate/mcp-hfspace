import { Client, handle_file } from "@gradio/client";
import { readFile } from "fs/promises";

async function main() {
  if (process.argv.length < 3) {
    console.error("Please provide an audio file path as argument");
//    process.exit(1);
  }

  //const audioFile = process.argv[2];

  try {
    const app = await Client.connect("suno/bark", {
      events: ["data", "status"],
    });
    const api = app.view_api();

    /*
    const submission = app.submit("/predict", {
      inputs: handle_file(audioFile),
    });
*/
    const submission = app.submit("/predict", [
      "howdy!"
//       handle_file(audioFile),
//       "transcribe"
    ]);

    for await (const msg of submission) {
      if (msg.type === "status") {
        console.log("Status:", JSON.stringify(msg, null, 2));
      }
      if (msg.type === "data") {
        console.log("Transcription:", msg.data);
        break; // Exit after getting the data
      }

      if (msg.stage === "error") {
        throw new Error(`Gradio error: ${msg.message || "Unknown error"}`);
      }
    }
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
