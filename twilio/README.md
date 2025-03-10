# Ultravox-Twilio Integration

This integration allows you to use Ultravox's AI voice capabilities with Twilio's telephony services for both incoming and outgoing calls.

## Features

- **Incoming Calls**: Automatically answer incoming calls and connect them to Ultravox
- **Outgoing Calls**: Programmatically initiate outbound calls with Ultravox
- **Customizable Prompts**: Configure system prompts for different use cases
- **Event Callbacks**: Receive and process call events

## Prerequisites

- Node.js v16 or higher
- Twilio account with phone number
- Ultravox API key

## Setup

1. Install dependencies

```bash
cd twilio_integration
npm install
```

2. Configure environment variables

Copy the `.env` file and fill in your credentials:

```
# Twilio Credentials
TWILIO_ACCOUNT_SID=your_sid_here
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_PHONE_NUMBER=your_twilio_phone_number

# Ultravox API
ULTRAVOX_API_KEY=your_ultravox_api_key
ULTRAVOX_AGENT_ID=your_ultravox_agent_id
ULTRAVOX_WEBSOCKET_URL=wss://api.ultravox.ai/v1/ws
ULTRAVOX_API_URL=https://api.ultravox.ai/api/calls

# Server configuration
PORT=3000
```

3. Start the server

```bash
npm start
```

## Usage

### Incoming Calls

1. Configure your Twilio phone number's webhook to point to your server's `/incoming` endpoint (you may need to use a tool like ngrok for local development).

2. When someone calls your Twilio number, the server will automatically connect them to Ultravox.

### Outgoing Calls

#### Using the CLI tool

```bash
node outbound-call.js
```

Follow the prompts to enter a phone number and optional system prompt.

#### Using the API

```bash
curl -X POST http://localhost:3000/outgoing \
  -H "Content-Type: application/json" \
  -d '{
    "destinationNumber": "+1234567890",
    "systemPrompt": "You are calling Westside Dentistry to confirm an appointment for Steven Smith at 8:30am on Wednesday July 2nd. Use corpus lookup if they need any personal information about Steven."
  }
```
## Webhook Configuration

For production use, you'll need to:

1. Deploy this server to a publicly accessible URL
2. Configure your Twilio phone number's voice webhook to point to `https://your-server.com/incoming`

## Development

For local development with Twilio, you can use a tunneling service like ngrok:

```bash
ngrok http 3000
```

Then update your Twilio webhook to use the ngrok URL.

## Advanced Configuration

You can modify `server.js` to customize the behavior of the integration, such as:

- Changing the default voice
- Implementing custom call routing logic
- Adding authentication to the API endpoints
- Processing call events in the `/callback` endpoint

## Troubleshooting

- **Call not connecting**: Check your Twilio and Ultravox credentials
- **No audio**: Ensure your Twilio phone number is properly configured
- **Server errors**: Check the console logs for detailed error messages 
