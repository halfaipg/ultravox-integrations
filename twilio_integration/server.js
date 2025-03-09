import express from 'express';
import twilio from 'twilio';
import https from 'https';
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Configuration from environment variables
const PORT = process.env.PORT || 3000;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const ULTRAVOX_API_KEY = process.env.ULTRAVOX_API_KEY;
const ULTRAVOX_API_URL = process.env.ULTRAVOX_API_URL;
const ULTRAVOX_AGENT_ID = process.env.ULTRAVOX_AGENT_ID;
const ULTRAVOX_CORPUS_ID = process.env.ULTRAVOX_CORPUS_ID;

// AI Assistant Configuration
const AI_NAME = process.env.AI_ASSISTANT_NAME || 'Jimothy';
const AI_VOICE = process.env.AI_ASSISTANT_VOICE_ID || '3abe60f5-13ed-4e82-ac15-4391d9e5cd9d';
const AI_TEMPERATURE = parseFloat(process.env.AI_TEMPERATURE) || 0.3;
const AI_FIRST_SPEAKER = process.env.AI_FIRST_SPEAKER || 'FIRST_SPEAKER_USER';

// Process system prompt by replacing variables
function processSystemPrompt(prompt) {
    return prompt.replace(/{AI_NAME}/g, AI_NAME);
}

// Get appropriate system prompt based on call type
function getSystemPrompt(isOutbound = false) {
    const prompt = isOutbound ? 
        process.env.OUTBOUND_SYSTEM_PROMPT :
        process.env.INBOUND_SYSTEM_PROMPT;
    return processSystemPrompt(prompt);
}

// Create Ultravox call and get join URL
async function createUltravoxCall(options = {}) {
    const {
        systemPrompt,
        isOutbound = false
    } = options;

    // Create base call config
    const callConfig = {
        systemPrompt: systemPrompt || getSystemPrompt(isOutbound),
        model: 'fixie-ai/ultravox',
        voice: AI_VOICE,
        temperature: AI_TEMPERATURE,
        firstSpeaker: AI_FIRST_SPEAKER,
        medium: { "twilio": {} },
        recordingEnabled: true
    };

    // Add queryCorpus tool if corpus ID is available
    if (ULTRAVOX_CORPUS_ID) {
        callConfig.selectedTools = [
            {
                toolName: "queryCorpus",
                parameterOverrides: {
                    corpus_id: ULTRAVOX_CORPUS_ID,
                    max_results: 5
                }
            }
        ];
    }

    console.log('Ultravox API call config:', JSON.stringify(callConfig, null, 2));

    return new Promise((resolve, reject) => {
        // Create HTTPS request
        const request = https.request(ULTRAVOX_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': ULTRAVOX_API_KEY
            }
        });

        let data = '';

        request.on('response', (response) => {
            console.log(`Ultravox API Status Code: ${response.statusCode}`);
            
            response.on('data', chunk => data += chunk);
            
            response.on('end', () => {
                try {
                    console.log('Ultravox API raw response:', data);
                    
                    // Check if response is HTML error page
                    if (data.includes('<!doctype html>') || data.includes('<html>')) {
                        console.error('Received HTML error page instead of JSON');
                        return reject(new Error('Received HTML error page from Ultravox API'));
                    }
                    
                    const parsedData = JSON.parse(data);
                    
                    if (!parsedData.joinUrl) {
                        console.error('Error: Ultravox API did not return a joinUrl', parsedData);
                        return reject(new Error('Ultravox API did not return a joinUrl'));
                    }
                    
                    console.log(`Successfully got join URL: ${parsedData.joinUrl}`);
                    resolve(parsedData);
                } catch (error) {
                    console.error('Failed to parse Ultravox API response:', error, data);
                    reject(new Error(`Failed to parse response: ${error.message}`));
                }
            });
        });

        request.on('error', (error) => {
            console.error('Ultravox API request error:', error);
            reject(error);
        });
        
        const requestBody = JSON.stringify(callConfig);
        console.log('Sending request to Ultravox API:', requestBody);
        request.write(requestBody);
        request.end();
    });
}

// Home route with basic information
app.get('/', (req, res) => {
    res.send('Ultravox-Twilio Integration Server. Use /incoming for incoming calls and /outgoing for outgoing calls.');
});

// Handle incoming calls from Twilio
app.post('/incoming', async (req, res) => {
    try {
        console.log('Incoming call received:', req.body);

        const caller = req.body.From;
        const callSid = req.body.CallSid;

        console.log(`Directly connecting call ${callSid} to Ultravox...`);

        const response = await createUltravoxCall({
            isOutbound: false
        });

        if (!response || !response.joinUrl) {
            throw new Error('Failed to get a valid join URL from Ultravox');
        }

        const twiml = new twilio.twiml.VoiceResponse();
        const connect = twiml.connect();
        connect.stream({
            url: response.joinUrl,
            name: 'ultravox'
        });

        console.log(`Sending connect TwiML for call ${callSid}:`, twiml.toString());
        res.type('text/xml');
        res.send(twiml.toString());

    } catch (error) {
        console.error('Error handling incoming call:', error);

        const twiml = new twilio.twiml.VoiceResponse();
        twiml.say('Sorry, there was an error processing your call.');

        res.type('text/xml');
        res.send(twiml.toString());
    }
});

// Stream status endpoint
app.post('/stream-status', (req, res) => {
    console.log('Stream status update:', req.body);
    res.sendStatus(200);
});

// API to initiate outgoing calls
app.post('/outgoing', async (req, res) => {
    try {
        const { destinationNumber, systemPrompt } = req.body;
        
        if (!destinationNumber) {
            return res.status(400).json({ error: 'Destination phone number is required' });
        }
        
        if (!TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
            return res.status(500).json({ 
                error: 'Twilio credentials not properly configured. Check TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER in .env file.' 
            });
        }

        console.log(`Creating Ultravox call for ${destinationNumber}...`);
        
        // Create an Ultravox call first
        const ultravoxResponse = await createUltravoxCall({
            systemPrompt: systemPrompt,
            isOutbound: true
        });
        
        if (!ultravoxResponse || !ultravoxResponse.joinUrl) {
            throw new Error('Failed to get a valid join URL from Ultravox');
        }
        
        console.log(`Got Ultravox join URL: ${ultravoxResponse.joinUrl}`);
        
        // Initialize Twilio client
        const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        
        // Make the call with direct Ultravox connection
        const call = await client.calls.create({
            twiml: `<Response><Connect><Stream url="${ultravoxResponse.joinUrl}"/></Connect></Response>`,
            to: destinationNumber,
            from: TWILIO_PHONE_NUMBER,
            statusCallback: `${req.protocol}://${req.get('host')}/call-status`,
            statusCallbackMethod: 'POST'
        });

        console.log(`Outbound call initiated with SID: ${call.sid}`);

        res.json({ 
            success: true, 
            message: 'Call initiated successfully', 
            callSid: call.sid
        });
        
    } catch (error) {
        console.error('Error initiating outgoing call:', error);
        res.status(500).json({ 
            error: 'Failed to initiate call', 
            message: error.message 
        });
    }
});

// Direct connect endpoint for outgoing calls
app.post('/direct-connect/:callId', async (req, res) => {
    try {
        const callId = req.params.callId;
        const systemPrompt = app.locals.callPrompts[callId];
        
        if (!systemPrompt) {
            throw new Error(`No system prompt found for call ID ${callId}`);
        }
        
        console.log(`Creating Ultravox call for direct connect with call ID ${callId}`);
        
        // Create an Ultravox call
        const ultravoxResponse = await createUltravoxCall({
            systemPrompt: systemPrompt,
            firstSpeaker: 'FIRST_SPEAKER_AGENT',
            callbackUrl: `${req.protocol}://${req.get('host')}/callback`
        });
        
        if (!ultravoxResponse || !ultravoxResponse.joinUrl) {
            throw new Error('Failed to get a valid join URL from Ultravox');
        }
        
        console.log(`Ultravox call created, join URL: ${ultravoxResponse.joinUrl}`);
        
        // Generate TwiML response
        const twiml = new twilio.twiml.VoiceResponse();
        
        // Connect to Ultravox
        const connect = twiml.connect();
        connect.stream({
            url: ultravoxResponse.joinUrl,
            name: 'ultravox'
        });
        
        // Remove the stored prompt to free up memory
        delete app.locals.callPrompts[callId];
        
        console.log(`Sending connect TwiML for direct connect call ${callId}`);
        res.type('text/xml');
        res.send(twiml.toString());
        
    } catch (error) {
        console.error('Error connecting outgoing call:', error);
        const twiml = new twilio.twiml.VoiceResponse();
        twiml.say('Sorry, we were unable to connect to our AI assistant at this time. Please try again later.');
        res.type('text/xml');
        res.send(twiml.toString());
    }
});

// Call status webhook
app.post('/call-status', (req, res) => {
    console.log('Call status update:', req.body);
    res.sendStatus(200);
});

// Webhook for call events from Ultravox
app.post('/callback', (req, res) => {
    const eventData = req.body;
    console.log('Received callback from Ultravox:', eventData);
    
    // Process event data as needed
    // You can add logic to handle different event types here
    
    res.status(200).send('Event received');
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`- Incoming calls endpoint: http://localhost:${PORT}/incoming`);
    console.log(`- Outgoing calls endpoint: http://localhost:${PORT}/outgoing`);
    
    if (!ULTRAVOX_API_KEY) {
        console.warn('WARNING: ULTRAVOX_API_KEY is not set');
    }
    
    if (!TWILIO_ACCOUNT_SID) {
        console.warn('WARNING: TWILIO_ACCOUNT_SID is not set');
    }
    
    if (!TWILIO_AUTH_TOKEN) {
        console.warn('WARNING: TWILIO_AUTH_TOKEN is not set');
    }
    
    if (!TWILIO_PHONE_NUMBER) {
        console.warn('WARNING: TWILIO_PHONE_NUMBER is not set');
    }

    if (!ULTRAVOX_CORPUS_ID) {
        console.warn('WARNING: ULTRAVOX_CORPUS_ID is not set - RAG functionality will be disabled');
    }
});