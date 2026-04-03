# NMS Health Coach

An embeddable AI health-coaching widget for the NewMindStart platform.  
The widget lives in the bottom-right corner of any page and connects to a lightweight Express backend that calls the OpenAI API.

## Project structure

```
backend/
  src/
    data/
      mockData.js          # mock user profiles (replace with real DB in production)
    routes/
      assistantRoutes.js   # POST /api/assistant/chat
    services/
      chatService.js       # builds the AI prompt and calls OpenAI
    server.js              # Express entry point, serves static files

assets/                    # NMS SVG logo files
index.html                 # chat widget UI
widget.css                 # widget styles
.env                       # API keys — never commit this file
```

## Running locally

```bash
npm install
```

Create a `.env` file in the project root (copy `.env.example` if present):

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini   # optional, defaults to gpt-4o-mini
PORT=3030                   # optional, defaults to 3030
```

Then start the server:

```bash
npm run dev
```

Open [http://localhost:3030](http://localhost:3030).

## Embedding on a page

Copy the `<section class="chat-widget">` block, the mini `<button class="chat-bubble">`, the `<link>` tag for `widget.css`, and the `<script>` block into your target page.  
Update `OPENAI_API_KEY` on the server side — the frontend never touches the key directly.
