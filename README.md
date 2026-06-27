# Tesseract

Tesseract is a powerful, developer-friendly Chrome extension that helps you capture, refine, and transfer conversation context between major AI platforms (Claude, ChatGPT, Gemini, and Grok).

## Features

- **Prompt Refiner**: Optimizes and structures your raw inputs on the fly using Groq, Anthropic, or Gemini API keys.
- **Context Capsules (Tesseracts)**: Extracts entire chat transcripts and compresses them into high-density context files.
- **Easy Context Injector**: Instantly drops saved context capsules into any new chat window to resume work seamlessly.
- **Premium Launcher UI**: A sleek, blue-glowing launcher button embedded directly into host input text areas with a glassmorphic selector popover.
- **Console Error Suppression**: Silently intercepts and blocks noisy ad-tracking connections and host-page errors (like `RequestError`) to keep your developer console clean.

---

## Installation

To install Tesseract as an unpacked developer extension:

1. **Download/Clone** this repository to your local machine.
2. Open **Google Chrome** and navigate to `chrome://extensions`.
3. Enable **Developer mode** using the toggle switch in the top-right corner.
4. Click the **Load unpacked** button in the top-left corner.
5. Select the repository root folder (which contains `manifest.json`).

---

## How It Works

1. **Configure API Keys**:
   - Click the Tesseract extension icon in your Chrome toolbar or open the launcher tray and navigate to the **Settings** tab.
   - Enter your API Key for your preferred provider (Groq, Anthropic, or Gemini) to enable prompt refinement.

2. **Refining Prompts**:
   - Open any supported platform (e.g., Claude, ChatGPT, Gemini, or Grok).
   - Start typing or paste your prompt into the message box. The Tesseract launcher button (the blue cube icon in the bottom-right of the input box) will begin **pulsating blue** to indicate text is ready for refinement.
   - Click the launcher and select **✨ Refine Prompt**. Tesseract will call your configured LLM in the background and instantly inject the refined, structured prompt directly back into the input box.

3. **Managing Context**:
   - Click the launcher button when the input is empty to open the **Tesseract Menu**.
   - Use **Extract & Save** to create a dense context capsule of your current chat.
   - Select any saved capsule to inject its context into a new conversation tab.

4. **Keyboard Shortcuts**:
   - `Alt + Shift + E`: Extract & Save current chat context.
   - `Alt + Shift + D`: Drop last saved capsule/context into the active chat.
   - `Alt + Shift + X`: Copy current chat text to clipboard.
