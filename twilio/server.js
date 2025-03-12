import express from 'express';
import twilio from 'twilio';
import https from 'https';
import http from 'http';
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { getToolsForCall } from './utils/tool-manager.js';
import { tools } from './config/tools.js';
import axios from 'axios';
import { WebSocketServer } from 'ws';

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
const VOICE_PROVIDER = process.env.VOICE_PROVIDER || 'twilio';

// UI Configuration
const UI_LOGO_URL = process.env.UI_LOGO_URL || 'https://brand.aipowergrid.io/_data/i/upload/2024/03/14/20240314185634-06dfd4e5-2s.png';
const UI_APP_NAME = process.env.UI_APP_NAME || 'AI Voice Agent';

// Twilio configuration
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// Telnyx configuration
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_PUBLIC_KEY = process.env.TELNYX_PUBLIC_KEY;
const TELNYX_APP_ID = process.env.TELNYX_APP_ID;
const TELNYX_PHONE_NUMBER = process.env.TELNYX_PHONE_NUMBER;

// Ultravox configuration
const ULTRAVOX_API_KEY = process.env.ULTRAVOX_API_KEY;
const ULTRAVOX_API_URL = process.env.ULTRAVOX_API_URL;
const ULTRAVOX_AGENT_ID = process.env.ULTRAVOX_AGENT_ID;
const ULTRAVOX_CORPUS_ID = process.env.ULTRAVOX_CORPUS_ID;

// AI Assistant Configuration
const AI_NAME = process.env.AI_ASSISTANT_NAME || 'Jimothy';
const AI_VOICE = process.env.AI_ASSISTANT_VOICE_ID || '3abe60f5-13ed-4e82-ac15-4391d9e5cd9d';
const AI_TEMPERATURE = parseFloat(process.env.AI_TEMPERATURE) || 0.3;
const OUTBOUND_FIRST_SPEAKER = process.env.OUTBOUND_FIRST_SPEAKER || 'FIRST_SPEAKER_USER';
const INBOUND_FIRST_SPEAKER = process.env.INBOUND_FIRST_SPEAKER || 'FIRST_SPEAKER_AGENT';
// Use a static preprompt instead of reading from env
const AGENT_PREPROMPT = "Your name is {AGENT_NAME} and you are using audible speech, so DO NOT vocalize anything that wouldn't be said out loud, such as 'asterisks screams asterisks' - instead you can say 'hmm' or 'umm' in place of pauses etc. Please strictly adhere to the following prompt:";
// Process system prompt by replacing variables
function processSystemPrompt(prompt, agentName) {
    // Use the provided agent name or fall back to the default AI_NAME
    const nameToUse = agentName || AI_NAME;
    
    // Add preprompt if needed
    let processedPrompt = prompt;
    // Always add the preprompt with the agent name
    const preprompt = AGENT_PREPROMPT.replace(/{AGENT_NAME}/g, nameToUse);
    processedPrompt = `${preprompt}\n\n${processedPrompt}`;
    
    // Replace any remaining {AI_NAME} placeholders in the prompt
    return processedPrompt.replace(/{AI_NAME}/g, nameToUse);
}

// Get appropriate system prompt based on call type
function getSystemPrompt(isOutbound = false, agentName = null) {
    let prompt = isOutbound ? 
        process.env.OUTBOUND_SYSTEM_PROMPT :
        process.env.INBOUND_SYSTEM_PROMPT;
    
    // Add tool information to the prompt if tools are enabled
    const toolNames = (process.env.ULTRAVOX_CALL_TOOLS || '').split(',').filter(Boolean);
    const useTools = process.env.ULTRAVOX_USE_TOOLS === 'true' || toolNames.length > 0;
    
    if (useTools) {
        prompt = enhancePromptWithToolInfo(prompt, toolNames);
    }
    
    return processSystemPrompt(prompt, agentName);
}

/**
 * Enhance the system prompt with information about available tools
 * @param {string} basePrompt - The original system prompt
 * @param {Array<string>} toolNames - Optional array of specific tool names to include
 * @returns {string} - Enhanced system prompt
 */
function enhancePromptWithToolInfo(basePrompt, toolNames = []) {
    // Get the tools that are available
    const availableTools = Object.values(tools);
    
    // Filter to specific tools if names provided
    const toolsToInclude = toolNames.length > 0
        ? availableTools.filter(tool => toolNames.includes(tool.name))
        : availableTools;

    if (toolsToInclude.length === 0) return basePrompt;

    // Build tool information for each tool
    const toolsInfo = toolsToInclude.map(tool => {
        // Start with the basic tool info
        let info = `\n${tool.description}\n`;

        // Add example queries if available
        if (tool.examples && tool.examples.length > 0) {
            tool.examples.forEach(example => {
                info += `\nExample: "${example.query}"\nResponse: "${example.response}"\n`;
            });
        }

        return info;
    }).join('\n');

    // Get guidelines from environment or use defaults
    const guidelines = process.env.ULTRAVOX_TOOL_GUIDELINES || '';

    // Combine everything
    return guidelines ? `${basePrompt}\n${toolsInfo}\n${guidelines}` : `${basePrompt}\n${toolsInfo}`;
}

// Update verifyCorpusStatus function with more concise logging
async function verifyCorpusStatus() {
    return new Promise((resolve, reject) => {
        const request = https.request(`${ULTRAVOX_API_URL.replace('/calls', '')}/corpora/${ULTRAVOX_CORPUS_ID}`, {
            method: 'GET',
            headers: {
                'X-API-Key': ULTRAVOX_API_KEY
            }
        });

        let data = '';
        
        request.on('response', (response) => {
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                try {
                    const corpus = JSON.parse(data);
                    if (corpus.stats?.status === 'CORPUS_STATUS_READY') {
                        resolve(true);
                    } else {
                        resolve(false);
                    }
                } catch (error) {
                    console.error('❌ Error checking corpus status:', error.message);
                    reject(error);
                }
            });
        });

        request.on('error', (error) => {
            console.error('❌ Error checking corpus status:', error.message);
            reject(error);
        });

        request.end();
    });
}

// Create Ultravox call and get join URL
async function createUltravoxCall(options = {}) {
    const {
        systemPrompt,
        isOutbound = false,
        voiceId,
        corpusId: overrideCorpusId,
        toolNames,
        agentName
    } = options;

    // Create base call config
    const callConfig = {
        systemPrompt: systemPrompt ? 
            processSystemPrompt(systemPrompt, agentName) : 
            getSystemPrompt(isOutbound, agentName),
        model: 'fixie-ai/ultravox-70B',  // Ensure we use 70B model which handles tools better
        voice: voiceId || AI_VOICE,
        temperature: AI_TEMPERATURE,
        firstSpeaker: isOutbound ? OUTBOUND_FIRST_SPEAKER : INBOUND_FIRST_SPEAKER,
        medium: { "twilio": {} },
        recordingEnabled: true,
        selectedTools: []
    };

    // Add tools only if explicitly provided or if ULTRAVOX_USE_TOOLS is true and toolNames is undefined
    // If toolNames is an empty array, tools should be disabled
    const useTools = toolNames === undefined ? 
        process.env.ULTRAVOX_USE_TOOLS !== 'false' : 
        toolNames.length > 0;
    
    if (useTools) {
        // Get tools from the tool manager, using provided tool names if specified
        const tools = getToolsForCall(toolNames || process.env.ULTRAVOX_CALL_TOOLS?.split(',').filter(Boolean));
        
        if (tools.length > 0) {
            callConfig.selectedTools = callConfig.selectedTools.concat(tools);
            console.log(`Adding ${tools.length} tools to ${isOutbound ? 'outbound' : 'inbound'} call:`, 
                tools.map(t => t.toolName || t.temporaryTool?.modelToolName).join(', '));
            
            // Enhance the system prompt with tool information if guidelines exist
            if (process.env.ULTRAVOX_TOOL_GUIDELINES) {
                callConfig.systemPrompt = enhancePromptWithToolInfo(callConfig.systemPrompt, toolNames);
            }
        }

        // Always add the built-in hangUp tool
        callConfig.selectedTools.push({ toolName: "hangUp" });
        console.log(`Added built-in hangUp tool to ${isOutbound ? 'outbound' : 'inbound'} call`);
    } else {
        console.log('Tools disabled for this call');
    }

    // Add queryCorpus tool with verification if needed
    const effectiveCorpusId = overrideCorpusId || ULTRAVOX_CORPUS_ID;
    if (effectiveCorpusId) {
        try {
            const isCorpusReady = await verifyCorpusStatus(effectiveCorpusId);
            
            if (isCorpusReady) {
                console.log(`Adding corpus configuration for ${isOutbound ? 'outbound' : 'inbound'} call. Corpus ID: ${effectiveCorpusId}`);
                
                callConfig.selectedTools.push({
                    toolName: "queryCorpus",
                    parameterOverrides: {
                        corpus_id: effectiveCorpusId,
                        max_results: 5
                    }
                });
            } else {
                console.warn('Corpus not in READY state - skipping RAG configuration');
            }
        } catch (error) {
            console.error('Error verifying corpus status:', error);
            // Continue without RAG if corpus verification fails
        }
    }

    // Add default tool instructions to system prompt if tools are enabled
    if (callConfig.selectedTools.length > 0) {
        callConfig.systemPrompt = `${callConfig.systemPrompt}

Important: You have access to several tools that enhance your capabilities. Always use these tools when relevant to provide accurate and up-to-date information. When using tools:
1. Use them proactively when relevant to the conversation
2. Format the information naturally in your responses
3. Don't mention that you're using a tool - just provide the information
4. If a tool call fails, gracefully inform the user you're unable to get that information right now
5. For the hangUp tool, only use it when the user requests to end the call or the conversation has reached a natural conclusion
6. Before using hangUp, always say "Alrighty, goodbye.." followed by a brief summary or closing statement to the user
`;
    }

    console.log('Final call configuration:', JSON.stringify(callConfig, null, 2));

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

// Initialize Telnyx client if using Telnyx provider
if (VOICE_PROVIDER === 'telnyx' && TELNYX_API_KEY) {
    // Initialize the Telnyx client with the API key
    // Note: Using axios for API calls rather than SDK initialization
    // as the telnyx SDK doesn't have setApiKey method
    console.log('Using Telnyx API Key for requests');
}

// Helper function to handle Telnyx media streaming
async function setupTelnyxMediaStreaming(req, callControlId, options = {}) {
    try {
        const {
            streamUrl,
            streamTrack = 'both_tracks',
            streamBidirectionalMode = 'rtp',
            streamBidirectionalCodec = 'PCMU'
        } = options;

        console.log(`Setting up Telnyx media streaming for call: ${callControlId}`);
        console.log(`Stream URL: ${streamUrl}, Stream Track: ${streamTrack}`);

        // Make sure we have a valid URL
        if (!streamUrl) {
            throw new Error('Stream URL is required for Telnyx media streaming');
        }

        // Make API call to start streaming
        try {
            const response = await axios({
                method: 'POST',
                url: `https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${TELNYX_API_KEY}`
                },
                data: {
                    stream_url: streamUrl,
                    stream_track: streamTrack,
                    stream_bidirectional_mode: streamBidirectionalMode,
                    stream_bidirectional_codec: streamBidirectionalCodec
                }
            });

            console.log('Telnyx streaming started successfully:', response.data);
            return response.data;
        } catch (error) {
            // Check if there's a more specific error message from Telnyx
            if (error.response && error.response.data && error.response.data.errors) {
                console.error('Telnyx streaming error details:', JSON.stringify(error.response.data.errors));
                
                // If the call isn't ready yet, we might want to retry
                if (error.response.status === 422) {
                    console.error('Call may not be in correct state for streaming. If this is a new call, try waiting for call.answered event before streaming.');
                }
            }
            throw error;
        }
    } catch (error) {
        console.error('Error setting up Telnyx media streaming:', error.message);
        throw error;
    }
}

// Initiates an outbound call using Telnyx
async function makeTelnyxOutboundCall(options = {}) {
    try {
        const {
            to,
            from = TELNYX_PHONE_NUMBER,
            streamUrl,
            streamTrack = 'both_tracks',
            answerUrl,
            statusCallback
        } = options;

        console.log(`Initiating Telnyx outbound call to ${to} from ${from}`);

        // Create the outbound call
        const response = await axios({
            method: 'POST',
            url: 'https://api.telnyx.com/v2/calls',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${TELNYX_API_KEY}`
            },
            data: {
                to,
                from,
                connection_id: TELNYX_APP_ID,
                stream_url: streamUrl,
                stream_track: streamTrack,
                webhook_url: statusCallback,
                webhook_url_method: 'POST'
            }
        });

        console.log('Telnyx outbound call initiated:', response.data);
        return response.data;
    } catch (error) {
        console.error('Error initiating Telnyx outbound call:', error);
        throw error;
    }
}

// Generate TeXML for Telnyx inbound calls (Telnyx's version of TwiML)
function generateTelnyxTeXML(options = {}) {
    const {
        streamUrl
    } = options;

    // Create XML for TeXML (Telnyx's version of TwiML)
    const texml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${streamUrl}"/>
    </Connect>
</Response>`;

    return texml;
}

// Add this before the other route definitions
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0',
        services: {
            twilio: !!TWILIO_AUTH_TOKEN && !!TWILIO_PHONE_NUMBER,
            telnyx: !!TELNYX_API_KEY && !!TELNYX_PHONE_NUMBER,
            ultravox: !!ULTRAVOX_API_KEY
        },
        active_provider: VOICE_PROVIDER
    });
});

// Home route with basic information
app.get('/', (req, res) => {
    res.send(`Ultravox Voice Integration Server. Using ${VOICE_PROVIDER.toUpperCase()} as the provider. Use /incoming for incoming calls and /outgoing for outgoing calls.`);
});

// UI Configuration endpoint
app.get('/config', (req, res) => {
    res.json({
        logoUrl: UI_LOGO_URL,
        appName: UI_APP_NAME,
        provider: VOICE_PROVIDER.toUpperCase()
    });
});

// Update the incoming call handler for both Twilio and Telnyx
app.post('/incoming', async (req, res) => {
    try {
        console.log('📞 Incoming call received:', req.body);
        
        // Handle differently based on the provider
        if (VOICE_PROVIDER === 'telnyx') {
            // Telnyx incoming call handling
            // Note: Telnyx sends events via webhooks, so this endpoint
            // will only be triggered if configured as a webhook URL
            
            // Check if this is a webhook event
            const event = req.body.data;
            if (event) {
                console.log(`Received Telnyx event: ${event.event_type}`);
                
                // Different handling based on event type
                if (event.event_type === 'call.initiated') {
                    const callControlId = event.payload.call_control_id;
                    const caller = event.payload.from;
                    
                    console.log(`Telnyx incoming call from ${caller} with call control ID: ${callControlId}`);
                    
                    // Answer the call first
                    try {
                        await axios({
                            method: 'POST',
                            url: `https://api.telnyx.com/v2/calls/${callControlId}/actions/answer`,
                            headers: {
                                'Content-Type': 'application/json',
                                'Accept': 'application/json',
                                'Authorization': `Bearer ${TELNYX_API_KEY}`
                            },
                            data: {}
                        });
                        console.log(`Answered call with control ID: ${callControlId}`);
                    } catch (error) {
                        console.error('Error answering Telnyx call:', error.message);
                    }
                    
                    // Return 200 immediately to acknowledge receipt
                    res.status(200).json({ success: true, message: 'Call initiated and answer command sent' });
                } 
                else if (event.event_type === 'call.answered') {
                    const callControlId = event.payload.call_control_id;
                    console.log(`Telnyx call answered with control ID: ${callControlId}`);
                    
                    console.log('🔍 Verifying RAG configuration for incoming Telnyx call...');
                    let corpusReady = false;
                    if (ULTRAVOX_CORPUS_ID) {
                        try {
                            corpusReady = await verifyCorpusStatus();
                            console.log('Corpus ready status:', corpusReady);
                        } catch (error) {
                            console.error('Error checking corpus:', error);
                        }
                    }
                    
                    console.log(`Setting up incoming Telnyx call ${callControlId} with${corpusReady ? '' : 'out'} RAG support...`);
                    
                    // Create Ultravox call
                    const response = await createUltravoxCall({
                        isOutbound: false,
                        systemPrompt: process.env.INBOUND_SYSTEM_PROMPT,
                        agentName: AI_NAME
                    });

                    if (!response || !response.joinUrl) {
                        throw new Error('Failed to get a valid join URL from Ultravox');
                    }
                    
                    // Get the hostname to build websocket URL
                    const hostname = req.get('host');
                    const protocol = req.protocol === 'https' ? 'wss' : 'ws';
                    
                    // Set up media streaming with Telnyx using our own websocket server
                    try {
                        await setupTelnyxMediaStreaming({
                            protocol: 'https',
                            get: (key) => key === 'host' ? 'localhost:' + PORT : ''
                        }, callControlId, {
                            streamUrl: response.joinUrl,
                            streamTrack: 'both_tracks'
                        });
                        
                        console.log(`Successfully connected Telnyx call to Ultravox`);
                    } catch (error) {
                        console.error('Error setting up Telnyx streaming:', error.message);
                        // If streaming fails, we may still want to continue the call
                        // Consider adding fallback logic here
                    }
                    
                    // Return 200 to acknowledge receipt
                    res.status(200).json({ success: true, message: 'Call answered and streaming started' });
                } 
                else {
                    // For other event types, just acknowledge receipt
                    console.log(`Received other Telnyx event: ${event.event_type}`);
                    res.status(200).json({ success: true });
                }
            } else {
                // If not a proper Telnyx event
                console.log('Received malformed Telnyx webhook event');
                res.status(400).json({ success: false, message: 'Malformed event' });
            }
        } else {
            // Default Twilio incoming call handling
            const caller = req.body.From;
            const callSid = req.body.CallSid;

            console.log('🔍 Verifying RAG configuration for incoming Twilio call...');
            
            // Verify corpus status before proceeding
            let corpusReady = false;
            if (ULTRAVOX_CORPUS_ID) {
                try {
                    corpusReady = await verifyCorpusStatus();
                    console.log('Corpus ready status:', corpusReady);
                } catch (error) {
                    console.error('Error checking corpus:', error);
                }
            }

            console.log(`Setting up incoming Twilio call ${callSid} with${corpusReady ? '' : 'out'} RAG support...`);

            const response = await createUltravoxCall({
                isOutbound: false,
                systemPrompt: process.env.INBOUND_SYSTEM_PROMPT,
                agentName: AI_NAME
            });

            if (!response || !response.joinUrl) {
                throw new Error('Failed to get a valid join URL from Ultravox');
            }

            console.log(`Successfully configured incoming call ${callSid} with RAG support`);

            const twiml = new twilio.twiml.VoiceResponse();
            const connect = twiml.connect();
            connect.stream({
                url: response.joinUrl,
                name: 'ultravox'
            });

            console.log(`Sending connect TwiML for call ${callSid}:`, twiml.toString());
            res.type('text/xml');
            res.send(twiml.toString());
        }
    } catch (error) {
        console.error('❌ Error handling incoming call:', error);
        
        if (VOICE_PROVIDER === 'telnyx') {
            // For Telnyx, return a JSON error response
            res.status(500).json({
                success: false,
                error: 'Failed to process incoming call',
                message: error.message
            });
        } else {
            // For Twilio, return a TwiML response
            const twiml = new twilio.twiml.VoiceResponse();
            twiml.say('Sorry, there was an error processing your call.');
            res.type('text/xml');
            res.send(twiml.toString());
        }
    }
});

// Telnyx webhook endpoints
app.post('/telnyx-webhook', (req, res) => {
    try {
        const event = req.body.data;
        console.log('Received Telnyx webhook event:', event ? event.event_type : 'Unknown event');
        
        // Handle the webhook event based on its type
        if (event && event.event_type) {
            switch (event.event_type) {
                case 'call.initiated':
                    console.log('Telnyx call initiated:', event.payload);
                    
                    // Answer the call automatically
                    try {
                        const callControlId = event.payload.call_control_id;
                        axios({
                            method: 'POST',
                            url: `https://api.telnyx.com/v2/calls/${callControlId}/actions/answer`,
                            headers: {
                                'Content-Type': 'application/json',
                                'Accept': 'application/json',
                                'Authorization': `Bearer ${TELNYX_API_KEY}`
                            },
                            data: {}
                        }).then(() => {
                            console.log(`Answered call with control ID: ${callControlId}`);
                        }).catch(err => {
                            console.error('Error answering call from webhook:', err.message);
                        });
                    } catch (error) {
                        console.error('Error processing call.initiated event:', error.message);
                    }
                    break;
                    
                case 'call.answered':
                    console.log('Telnyx call answered:', event.payload);
                    
                    // Set up Ultravox call and streaming
                    try {
                        const callControlId = event.payload.call_control_id;
                        
                        // Create an Ultravox call asynchronously
                        createUltravoxCall({
                            isOutbound: false,
                            systemPrompt: process.env.INBOUND_SYSTEM_PROMPT,
                            agentName: AI_NAME
                        }).then(response => {
                            if (!response || !response.joinUrl) {
                                console.error('Failed to get a valid join URL from Ultravox');
                                return;
                            }
                            
                            // Set up streaming with the Ultravox join URL
                            return setupTelnyxMediaStreaming({
                                protocol: 'https',
                                get: (key) => key === 'host' ? 'localhost:' + PORT : ''
                            }, callControlId, {
                                streamUrl: response.joinUrl,
                                streamTrack: 'both_tracks'
                            });
                        }).then(streamingResponse => {
                            console.log('Successfully set up streaming from webhook');
                        }).catch(err => {
                            console.error('Error setting up streaming from webhook:', err.message);
                        });
                    } catch (error) {
                        console.error('Error processing call.answered event:', error.message);
                    }
                    break;
                    
                case 'call.hangup':
                    console.log('Telnyx call hung up:', event.payload);
                    break;
                    
                case 'call.playback.started':
                    console.log('Telnyx playback started:', event.payload);
                    break;
                    
                case 'call.playback.ended':
                    console.log('Telnyx playback ended:', event.payload);
                    break;
                    
                case 'call.speak.started':
                    console.log('Telnyx speak started:', event.payload);
                    break;
                    
                case 'call.speak.ended':
                    console.log('Telnyx speak ended:', event.payload);
                    break;
                    
                case 'call.dtmf.received':
                    console.log('Telnyx DTMF received:', event.payload);
                    break;
                    
                case 'streaming.started':
                    console.log('Telnyx streaming started:', event.payload);
                    break;
                    
                case 'streaming.stopped':
                    console.log('Telnyx streaming stopped:', event.payload);
                    break;
                    
                default:
                    console.log(`Unhandled Telnyx event type: ${event.event_type}`);
            }
        }
        
        // Acknowledge receipt of the webhook
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error handling Telnyx webhook:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// WebSocket endpoint for Telnyx media streaming
app.get('/stream-ws', (req, res) => {
    res.status(400).send('This endpoint is meant for WebSocket connections only');
});

// Stream status endpoint
app.post('/stream-status', (req, res) => {
    console.log('Stream status update:', req.body);
    res.sendStatus(200);
});

// API to initiate outgoing calls
app.post('/outgoing', async (req, res) => {
    try {
        const { 
            destinationNumber, 
            systemPrompt,
            voiceId,
            corpusId,
            tools: requestedTools,
            agentName
        } = req.body;
        
        if (!destinationNumber) {
            return res.status(400).json({ error: 'Destination phone number is required' });
        }
        
        // Check if we have the required credentials based on the active provider
        if (VOICE_PROVIDER === 'telnyx') {
            if (!TELNYX_API_KEY || !TELNYX_PHONE_NUMBER || !TELNYX_APP_ID) {
                return res.status(500).json({ 
                    error: 'Telnyx credentials not properly configured. Check TELNYX_API_KEY, TELNYX_PHONE_NUMBER, and TELNYX_APP_ID in .env file.' 
                });
            }
        } else {
            // Default to Twilio
            if (!TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
                return res.status(500).json({ 
                    error: 'Twilio credentials not properly configured. Check TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER in .env file.' 
                });
            }
        }

        console.log(`Creating Ultravox call for ${destinationNumber}...`);
        
        // Create an Ultravox call with custom configuration
        const ultravoxResponse = await createUltravoxCall({
            systemPrompt: systemPrompt,
            isOutbound: true,
            voiceId: voiceId,
            corpusId: corpusId,
            toolNames: requestedTools,
            agentName: agentName
        });
        
        if (!ultravoxResponse || !ultravoxResponse.joinUrl) {
            throw new Error('Failed to get a valid join URL from Ultravox');
        }
        
        console.log(`Got Ultravox join URL: ${ultravoxResponse.joinUrl}`);
        
        let callId;
        const statusCallbackUrl = `${req.protocol}://${req.get('host')}/call-status`;
        
        if (VOICE_PROVIDER === 'telnyx') {
            // Make call using Telnyx
            console.log(`Initiating Telnyx outbound call to ${destinationNumber}...`);
            
            const telnyxResponse = await makeTelnyxOutboundCall({
                to: destinationNumber,
                from: TELNYX_PHONE_NUMBER,
                streamUrl: ultravoxResponse.joinUrl,
                statusCallback: statusCallbackUrl
            });
            
            if (!telnyxResponse || !telnyxResponse.data || !telnyxResponse.data.call_control_id) {
                throw new Error('Failed to initiate call with Telnyx');
            }
            
            callId = telnyxResponse.data.call_control_id;
            console.log(`Outbound Telnyx call initiated with call control ID: ${callId}`);
        } else {
            // Make call using Twilio (default)
            const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
            
            // Make the call with direct Ultravox connection
            const call = await client.calls.create({
                twiml: `<Response><Connect><Stream url="${ultravoxResponse.joinUrl}"/></Connect></Response>`,
                to: destinationNumber,
                from: TWILIO_PHONE_NUMBER,
                statusCallback: statusCallbackUrl,
                statusCallbackMethod: 'POST'
            });

            callId = call.sid;
            console.log(`Outbound Twilio call initiated with SID: ${callId}`);
        }

        res.json({ 
            success: true, 
            message: 'Call initiated successfully', 
            callId: callId,
            provider: VOICE_PROVIDER,
            configuration: {
                agentName: agentName || AI_NAME,
                voiceId: voiceId || AI_VOICE,
                corpusId: corpusId || ULTRAVOX_CORPUS_ID,
                tools: requestedTools || process.env.ULTRAVOX_CALL_TOOLS?.split(',') || []
            }
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
        const agentName = app.locals.callAgentNames ? app.locals.callAgentNames[callId] : null;
        
        if (!systemPrompt) {
            throw new Error(`No system prompt found for call ID ${callId}`);
        }
        
        console.log(`Creating Ultravox call for direct connect with call ID ${callId}`);
        
        // Create an Ultravox call
        const ultravoxResponse = await createUltravoxCall({
            systemPrompt: systemPrompt,
            agentName: agentName,
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
        if (app.locals.callAgentNames) {
            delete app.locals.callAgentNames[callId];
        }
        
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

// Add this before the other route definitions
app.get('/voices', async (req, res) => {
    try {
        console.log('Fetching voices from Ultravox API...');
        const response = await new Promise((resolve, reject) => {
            const request = https.request(`${ULTRAVOX_API_URL.replace('/calls', '')}/voices`, {
                method: 'GET',
                headers: {
                    'X-API-Key': ULTRAVOX_API_KEY
                },
                timeout: 10000 // 10 second timeout
            });

            let data = '';
            
            request.on('response', (response) => {
                response.on('data', chunk => data += chunk);
                response.on('end', () => {
                    try {
                        if (response.statusCode !== 200) {
                            reject(new Error(`Ultravox API returned status ${response.statusCode}`));
                            return;
                        }
                        
                        const voices = JSON.parse(data);
                        resolve(voices);
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            request.on('error', reject);
            request.on('timeout', () => {
                request.destroy();
                reject(new Error('Request timed out'));
            });
            
            request.end();
        });

        res.json(response);
    } catch (error) {
        console.error('Error fetching voices:', error);
        res.status(500).json({ 
            error: 'Failed to fetch voices', 
            message: error.message,
            results: [] // Always provide an empty results array for the frontend
        });
    }
});

// Corpus Management Endpoints
app.get('/list-corpora', async (req, res) => {
    try {
        console.log('Fetching corpora from Ultravox API...');
        const response = await axios({
            method: 'GET',
            url: `${ULTRAVOX_API_URL.replace('/calls', '')}/corpora`,
            headers: {
                'X-API-Key': ULTRAVOX_API_KEY
            },
            timeout: 10000 // 10 second timeout
        });
        
        res.json({
            success: true,
            corpora: response.data.results || []
        });
    } catch (error) {
        console.error('Error listing corpora:', error);
        res.status(500).json({ 
            error: 'Failed to list corpora', 
            message: error.message,
            corpora: [] // Always provide an empty corpora array for the frontend
        });
    }
});

app.post('/create-corpus', async (req, res) => {
    try {
        const { name, description, urls } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: 'Corpus name is required' });
        }
        
        // 1. Create the corpus via Ultravox API
        const corpusResponse = await axios({
            method: 'POST',
            url: `${ULTRAVOX_API_URL.replace('/calls', '')}/corpora`,
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': ULTRAVOX_API_KEY
            },
            data: {
                name,
                description: description || `Corpus created via Voice Agent UI`
            }
        });
        
        const corpusId = corpusResponse.data.corpusId;
        
        // 2. Process URLs and create sources for each
        const sourcePromises = [];
        if (urls && urls.trim()) {
            const urlList = urls.split(',').map(url => url.trim()).filter(url => url);
            
            for (const url of urlList) {
                // Create a source for each URL
                sourcePromises.push(
                    axios({
                        method: 'POST',
                        url: `${ULTRAVOX_API_URL.replace('/calls', '')}/corpora/${corpusId}/sources`,
                        headers: {
                            'Content-Type': 'application/json',
                            'X-API-Key': ULTRAVOX_API_KEY
                        },
                        data: {
                            name: `Source: ${url}`,
                            loadSpec: {
                                startUrls: [url],
                                maxDepth: 1 // Only fetch the provided URL, not linked pages
                            }
                        }
                    }).catch(error => {
                        console.error(`Error adding source ${url}:`, error.message);
                        return { 
                            status: 'rejected',
                            url,
                            error: error.message
                        };
                    })
                );
            }
        }
        
        // Wait for all source creation requests to complete
        const sourceResults = await Promise.all(sourcePromises);
        
        // Count successes and failures
        const succeeded = sourceResults.filter(r => !r.status || r.status !== 'rejected').length;
        const failed = sourceResults.filter(r => r.status === 'rejected').length;
        
        res.json({
            success: true,
            corpusId,
            message: `Corpus created successfully with ${succeeded} sources. ${failed} sources failed.`,
            sourceStatus: sourceResults.map((result, index) => {
                if (result.status === 'rejected') {
                    return {
                        url: urls.split(',')[index].trim(),
                        status: 'failed',
                        error: result.error
                    };
                } else {
                    return {
                        url: urls.split(',')[index].trim(),
                        status: 'success'
                    };
                }
            })
        });
        
    } catch (error) {
        console.error('Error creating corpus:', error);
        res.status(500).json({ 
            error: 'Failed to create corpus', 
            message: error.message,
            details: error.response?.data
        });
    }
});

// Delete corpus endpoint
app.delete('/corpus/:corpusId', async (req, res) => {
    try {
        const { corpusId } = req.params;
        
        if (!corpusId) {
            return res.status(400).json({ error: 'Corpus ID is required' });
        }
        
        // Delete the corpus via Ultravox API
        await axios({
            method: 'DELETE',
            url: `${ULTRAVOX_API_URL.replace('/calls', '')}/corpora/${corpusId}`,
            headers: {
                'X-API-Key': ULTRAVOX_API_KEY
            }
        });
        
        res.json({
            success: true,
            message: `Corpus ${corpusId} deleted successfully`
        });
        
    } catch (error) {
        console.error('Error deleting corpus:', error);
        res.status(500).json({ 
            error: 'Failed to delete corpus', 
            message: error.message,
            details: error.response?.data
        });
    }
});

// Add a test endpoint for Telnyx integration
app.get('/test-telnyx', async (req, res) => {
    try {
        // Verify Telnyx credentials
        console.log('Testing Telnyx integration...');
        
        if (VOICE_PROVIDER !== 'telnyx') {
            return res.json({
                success: false,
                message: 'Telnyx is not the active voice provider. Set VOICE_PROVIDER=telnyx in .env file.',
                currentProvider: VOICE_PROVIDER
            });
        }
        
        if (!TELNYX_API_KEY) {
            return res.json({
                success: false,
                message: 'TELNYX_API_KEY is not set. Please add it to your .env file.'
            });
        }
        
        if (!TELNYX_APP_ID) {
            return res.json({
                success: false,
                message: 'TELNYX_APP_ID is not set. Please add it to your .env file.'
            });
        }
        
        if (!TELNYX_PHONE_NUMBER) {
            return res.json({
                success: false,
                message: 'TELNYX_PHONE_NUMBER is not set. Please add it to your .env file.'
            });
        }
        
        // Try to hit the Telnyx API to verify the key works
        try {
            const response = await axios({
                method: 'GET',
                url: 'https://api.telnyx.com/v2/calls',
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${TELNYX_API_KEY}`
                }
            });
            
            return res.json({
                success: true,
                message: 'Telnyx API key is valid and working.',
                configuration: {
                    apiKey: TELNYX_API_KEY ? `${TELNYX_API_KEY.substring(0, 10)}...` : 'Not set',
                    appId: TELNYX_APP_ID,
                    phoneNumber: TELNYX_PHONE_NUMBER,
                    provider: VOICE_PROVIDER
                },
                webhookUrls: {
                    telnyx: `${req.protocol}://${req.get('host')}/telnyx-webhook`,
                    streaming: `ws://${req.get('host')}/stream-ws`
                },
                note: 'Make sure your Telnyx webhooks are configured to point to your webhook URL'
            });
        } catch (error) {
            let errorMessage = 'Error calling Telnyx API';
            
            if (error.response) {
                const status = error.response.status;
                
                if (status === 401) {
                    errorMessage = 'Invalid Telnyx API key - authentication failed';
                } else if (status === 403) {
                    errorMessage = 'Telnyx API key does not have permission to access this resource';
                } else if (status === 404) {
                    errorMessage = 'Telnyx API endpoint not found - check API version';
                } else {
                    errorMessage = `Telnyx API error: ${status} - ${error.response.data?.errors?.[0]?.title || error.message}`;
                }
            }
            
            return res.json({
                success: false,
                message: errorMessage,
                error: error.message,
                configuration: {
                    apiKey: TELNYX_API_KEY ? `${TELNYX_API_KEY.substring(0, 10)}...` : 'Not set',
                    appId: TELNYX_APP_ID,
                    phoneNumber: TELNYX_PHONE_NUMBER,
                    provider: VOICE_PROVIDER
                }
            });
        }
    } catch (error) {
        console.error('Error testing Telnyx integration:', error);
        res.status(500).json({
            success: false,
            message: 'Error testing Telnyx integration',
            error: error.message
        });
    }
});

// Setup WebSocket server for Telnyx media streaming
// Create an HTTP server
const server = http.createServer(app);

// Create a WebSocket server using the HTTP server
const wss = new WebSocketServer({ 
    server,
    path: '/stream-ws'
});

// Store active streaming connections
const activeStreams = new Map();

// Track sequence numbers for streaming
let sequenceCounter = 1;

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    console.log('New WebSocket connection established');
    
    // Generate a unique stream ID
    const streamId = `stream-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    activeStreams.set(streamId, ws);
    
    // Send connected event to client
    ws.send(JSON.stringify({ 
        event: 'connected', 
        version: '1.0.0'
    }));
    
    // Send start event with media format details
    ws.send(JSON.stringify({
        event: 'start',
        sequence_number: (sequenceCounter++).toString(),
        start: {
            user_id: "Ultravox-Telnyx-Integration",
            call_control_id: req.query?.callControlId || "unknown",
            call_session_id: req.query?.callSessionId || streamId,
            from: req.query?.from || "unknown",
            to: req.query?.to || "unknown",
            tags: ["Ultravox", "Integration"],
            client_state: "",
            media_format: {
                encoding: "PCMU",
                sample_rate: 8000
            }
        },
        stream_id: streamId
    }));
    
    // Handle incoming messages from WebSocket clients
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            console.log('Received WebSocket message:', data.event);
            
            // Handle different event types
            switch (data.event) {
                case 'media':
                    // Handle media events (for bidirectional media streaming)
                    if (data.media && data.media.payload) {
                        console.log('Received media payload, length:', data.media.payload.length);
                        
                        // Here you would process and forward the audio
                        // For a complete implementation, this would send audio to the Ultravox service
                        
                        // Send acknowledgment
                        ws.send(JSON.stringify({
                            event: 'ack',
                            stream_id: streamId,
                            sequence_number: (sequenceCounter++).toString()
                        }));
                    }
                    break;
                    
                case 'mark':
                    // Echo back mark events immediately
                    if (data.mark && data.mark.name) {
                        console.log('Received mark event:', data.mark.name);
                        ws.send(JSON.stringify({
                            event: 'mark',
                            stream_id: streamId,
                            sequence_number: (sequenceCounter++).toString(),
                            mark: {
                                name: data.mark.name
                            }
                        }));
                    }
                    break;
                    
                case 'clear':
                    // Handle clear events
                    console.log('Received clear event, clearing media queue');
                    ws.send(JSON.stringify({
                        event: 'cleared',
                        stream_id: streamId,
                        sequence_number: (sequenceCounter++).toString()
                    }));
                    break;
                    
                case 'dtmf':
                    // Handle DTMF events
                    console.log('Received DTMF event:', data.dtmf?.digit);
                    // Forward this to the appropriate handler
                    break;
                    
                default:
                    console.log(`Unhandled WebSocket event type: ${data.event}`);
            }
        } catch (error) {
            console.error('Error processing WebSocket message:', error);
            // Send error message
            ws.send(JSON.stringify({
                event: 'error',
                payload: {
                    code: 100003,
                    title: 'malformed_frame',
                    detail: 'The received frame was not formed correctly'
                },
                stream_id: streamId
            }));
        }
    });
    
    // Handle WebSocket close
    ws.on('close', () => {
        console.log(`WebSocket connection closed for stream ${streamId}`);
        
        // Send streaming.stopped webhook event
        try {
            axios({
                method: 'POST',
                url: `${req.protocol}://${req.headers.host}/telnyx-webhook`,
                headers: { 'Content-Type': 'application/json' },
                data: {
                    data: {
                        event_type: 'streaming.stopped',
                        payload: {
                            call_control_id: req.query?.callControlId || "unknown",
                            stream_url: `${req.protocol}://${req.headers.host}/stream-ws`
                        }
                    }
                }
            }).catch(err => {
                console.error('Error sending streaming.stopped event:', err.message);
            });
        } catch (error) {
            console.error('Error generating webhook event:', error);
        }
        
        // Remove from active streams
        activeStreams.delete(streamId);
    });
    
    // Handle WebSocket errors
    ws.on('error', (error) => {
        console.error(`WebSocket error for stream ${streamId}:`, error);
        activeStreams.delete(streamId);
    });
    
    // Send streaming.started webhook event
    try {
        axios({
            method: 'POST',
            url: `${req.protocol}://${req.headers.host}/telnyx-webhook`,
            headers: { 'Content-Type': 'application/json' },
            data: {
                data: {
                    event_type: 'streaming.started',
                    payload: {
                        call_control_id: req.query?.callControlId || "unknown",
                        stream_url: `${req.protocol}://${req.headers.host}/stream-ws`
                    }
                }
            }
        }).catch(err => {
            console.error('Error sending streaming.started event:', err.message);
        });
    } catch (error) {
        console.error('Error generating webhook event:', error);
    }
});

// Start server
server.listen(PORT, async () => {
    // Log any missing configurations first (will be hidden by the clean output)
    const configWarnings = [];
    if (!ULTRAVOX_API_KEY) {
        configWarnings.push('WARNING: ULTRAVOX_API_KEY is not set');
    }
    
    if (VOICE_PROVIDER === 'twilio') {
        // Check Twilio credentials
        if (!TWILIO_ACCOUNT_SID) {
            configWarnings.push('WARNING: TWILIO_ACCOUNT_SID is not set');
        }
        
        if (!TWILIO_AUTH_TOKEN) {
            configWarnings.push('WARNING: TWILIO_AUTH_TOKEN is not set');
        }
        
        if (!TWILIO_PHONE_NUMBER) {
            configWarnings.push('WARNING: TWILIO_PHONE_NUMBER is not set');
        }
    } else if (VOICE_PROVIDER === 'telnyx') {
        // Check Telnyx credentials
        if (!TELNYX_API_KEY) {
            configWarnings.push('WARNING: TELNYX_API_KEY is not set');
        }
        
        if (!TELNYX_PUBLIC_KEY) {
            configWarnings.push('WARNING: TELNYX_PUBLIC_KEY is not set');
        }
        
        if (!TELNYX_APP_ID) {
            configWarnings.push('WARNING: TELNYX_APP_ID is not set');
        }
        
        if (!TELNYX_PHONE_NUMBER) {
            configWarnings.push('WARNING: TELNYX_PHONE_NUMBER is not set');
        }
    }

    // Start with the status section directly
    console.log('--- Status ---');
    
    // Log active voice provider
    console.log(`🔊 Active voice provider: ${VOICE_PROVIDER.toUpperCase()}`);
    
    // Log tool configuration with hangUp tool included
    const useTools = process.env.ULTRAVOX_USE_TOOLS === 'true';
    if (useTools) {
        // Get available tools and add hangUp tool explicitly
        const availableTools = Object.keys(tools);
        const allTools = [...availableTools, 'hangUp']; // Explicitly add hangUp tool
        
        console.log(`🔧 Configured ${allTools.length} Ultravox tools`);
        if (allTools.length > 0) {
            console.log('📋 Available tools:', allTools.join(', '));
        }
    } else {
        console.log('🔧 Tools disabled in environment');
    }
    
    // Check corpus status
    if (ULTRAVOX_CORPUS_ID) {
        try {
            const isCorpusReady = await verifyCorpusStatus();
            if (isCorpusReady) {
                console.log('📚 Corpus ready:', ULTRAVOX_CORPUS_ID);
            } else {
                console.warn('⚠️ Corpus not ready:', ULTRAVOX_CORPUS_ID);
            }
        } catch (error) {
            console.error('❌ Error checking corpus:', ULTRAVOX_CORPUS_ID);
        }
    } else {
        console.log('📚 No corpus configured');
    }

    // Add a blank line before server info
    console.log('\n--- Server Info ---');
    console.log(`Server running on port ${PORT}`);
    console.log(`- Incoming calls endpoint: http://localhost:${PORT}/incoming`);
    console.log(`- Outgoing calls endpoint: http://localhost:${PORT}/outgoing`);
    
    if (VOICE_PROVIDER === 'telnyx') {
        console.log(`- Telnyx webhook endpoint: http://localhost:${PORT}/telnyx-webhook`);
        console.log(`- Media streaming WebSocket: ws://localhost:${PORT}/stream-ws`);
        console.log(`- Telnyx test endpoint: http://localhost:${PORT}/test-telnyx`);
        console.log('\n✅ TIP: Visit the test endpoint to verify your Telnyx configuration');
    }
    
    // Log warnings at the very end if there are any
    if (configWarnings.length > 0) {
        console.log('\n--- Configuration Warnings ---');
        configWarnings.forEach(warning => console.warn(warning));
    }
});