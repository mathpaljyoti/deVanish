import WebSocket from "ws";
import {
  SYSTEM_MESSAGE,
  VOICE,
  LOG_EVENT_TYPES,
  SHOW_TIMING_MATH,
} from "../utils/constants.js";
import { writeFile } from 'fs/promises';

export const handleWebSocketConnection = (connection, req, OPENAI_API_KEY) => {
  let streamSid = null;
  let latestMediaTimestamp = 0;
  let lastAssistantItem = null;
  let markQueue = [];
  let responseStartTimestampTwilio = null;

  let audioChunks = [];

  const openAiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  const initializeSession = () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad" },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: VOICE,
        instructions: SYSTEM_MESSAGE,
        modalities: ["text", "audio"],
        temperature: 0.8,
      },
    };

    console.log("Sending session update:", JSON.stringify(sessionUpdate));
    openAiWs.send(JSON.stringify(sessionUpdate));

    // sendInitialConversationItem();
  };

  const sendInitialConversationItem = () => {
    const initialConversationItem = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: 'Greet the user with "Hello there! I am an AI voice assistant powered by Twilio and the OpenAI Realtime API. You can ask me for facts, jokes, or anything you can imagine. How can I help you?"',
          },
        ],
      },
    };

    if (SHOW_TIMING_MATH)
      console.log(
        "Sending initial conversation item:",
        JSON.stringify(initialConversationItem)
      );
    openAiWs.send(JSON.stringify(initialConversationItem));
    openAiWs.send(JSON.stringify({ type: "response.create" }));
  };

  const handleSpeechStartedEvent = () => {
    if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
      const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
      if (SHOW_TIMING_MATH)
        console.log(
          `Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`
        );

      if (lastAssistantItem) {
        const truncateEvent = {
          type: "conversation.item.truncate",
          item_id: lastAssistantItem,
          content_index: 0,
          audio_end_ms: elapsedTime,
        };
        if (SHOW_TIMING_MATH)
          console.log(
            "Sending truncation event:",
            JSON.stringify(truncateEvent)
          );
        openAiWs.send(JSON.stringify(truncateEvent));
      }

      connection.send(
        JSON.stringify({
          event: "clear",
          streamSid: streamSid,
        })
      );

      markQueue = [];
      lastAssistantItem = null;
      responseStartTimestampTwilio = null;
    }
  };

  const sendMark = (connection, streamSid) => {
    if (streamSid) {
      const markEvent = {
        event: "mark",
        streamSid: streamSid,
        mark: { name: "responsePart" },
      };
      connection.send(JSON.stringify(markEvent));
      markQueue.push("responsePart");
    }
  };

  openAiWs.on("open", () => {
    setTimeout(initializeSession, 250);
  });

  openAiWs.on("message", (data) => {
    try {
      const response = JSON.parse(data);

      if (LOG_EVENT_TYPES.includes(response.type)) {
        console.log(`Received event: ${response.type}`, response);
      }

      if (response.type === "response.audio.delta" && response.delta) {
        const audioDelta = {
          event: "media",
          streamSid: streamSid,
          media: {
            payload: Buffer.from(response.delta, "base64").toString("base64"),
          },
        };
        connection.send(JSON.stringify(audioDelta));

        if (!responseStartTimestampTwilio) {
          responseStartTimestampTwilio = latestMediaTimestamp;
          if (SHOW_TIMING_MATH)
            console.log(
              `Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`
            );
        }

        if (response.item_id) {
          lastAssistantItem = response.item_id;
        }

        sendMark(connection, streamSid);
      }

      if (response.type === "input_audio_buffer.speech_started") {
        handleSpeechStartedEvent();
      }
    } catch (error) {
      console.error(
        "Error processing OpenAI message:",
        error,
        "Raw message:",
        data
      );
    }
  });

  connection.on("message", (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.event) {
        case "media":
          latestMediaTimestamp = data.media.timestamp;
          if (SHOW_TIMING_MATH)
            console.log(
              `Received media message with timestamp: ${latestMediaTimestamp}ms`
            );
          if (openAiWs.readyState === WebSocket.OPEN) {
            const audioAppend = {
              type: "input_audio_buffer.append",
              audio: data.media.payload,
            };
            openAiWs.send(JSON.stringify(audioAppend));
            audioChunks.push(data.media.payload);
          }
          break;
        case "start":
          streamSid = data.start.streamSid;
          console.log("Incoming stream has started", streamSid);

          responseStartTimestampTwilio = null;
          latestMediaTimestamp = 0;
          break;
        case "mark":
          if (markQueue.length > 0) {
            markQueue.shift();
          }
          break;
        default:
          console.log("Received non-media event:", data.event);
          break;
      }
    } catch (error) {
      console.error("Error parsing message:", error, "Message:", message);
    }
  });

  connection.on("close", async () => {
    if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();

    const completeAudioBuffer = Buffer.concat(
      audioChunks.map((chunk) => Buffer.from(chunk, "base64"))
    );
  
    try {
      await writeFile("conversation_recording.raw", completeAudioBuffer);
      console.log("Conversation recording saved as conversation_recording.wav");
    } catch (error) {
      console.error("Error saving the audio recording:", error);
    }
  });

  openAiWs.on("close", () => console.log("Disconnected from OpenAI API",));
  openAiWs.on("error", (error) => console.error("WebSocket error:", error));
};
