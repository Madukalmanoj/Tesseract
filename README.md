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

To install the Tesseract extension on any Chromium-based browser (Google Chrome, Microsoft Edge, Brave, Opera, etc.):

1. **Download the Repository ZIP**: 
   - Click the green **Code** button on the GitHub repository page and select **Download ZIP** (or clone the repository).
2. **Extract the ZIP**:
   - Locate the downloaded `.zip` file on your machine and extract/unzip it into a folder of your choice.
3. **Open the Browser Extensions Page**:
   - Open your web browser and navigate to the extensions settings page:
     - **Google Chrome**: `chrome://extensions/`
     - **Microsoft Edge**: `edge://extensions/`
     - **Brave Browser**: `brave://extensions/`
4. **Enable Developer Mode**:
   - Turn on the **Developer mode** toggle switch (usually located in the top-right corner of the extensions page).
5. **Load the Unpacked Extension**:
   - Click the **Load unpacked** button (usually located in the top-left corner).
   - In the file selection dialog, select the extracted folder (choose the directory that directly contains the `manifest.json` file).

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
