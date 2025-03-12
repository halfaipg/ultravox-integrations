import express from 'express';
import twilio from 'twilio';
import https from 'https';
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { getToolsForCall } from './utils/tool-manager.js';
import { tools } from './config/tools.js';
import axios from 'axios';

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
const OUTBOUND_FIRST_SPEAKER = process.env.OUTBOUND_FIRST_SPEAKER || 'FIRST_SPEAKER_USER';
const INBOUND_FIRST_SPEAKER = process.env.INBOUND_FIRST_SPEAKER || 'FIRST_SPEAKER_AGENT';
// Use a static preprompt instead of reading from env
const AGENT_PREPROMPT = "Your name is {AGENT_NAME} and you are speaking with a human audible voice, so don't vocalize anything that wouldnt be spoken, you can say 'um' or 'hm' in place of pauses etc. Please stricly adhere to the following prompt:";

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
6. Before using hangUp, provide a brief summary or closing statement to the user
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

// Add this before the other route definitions
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0',
        services: {
            twilio: !!TWILIO_AUTH_TOKEN && !!TWILIO_PHONE_NUMBER,
            ultravox: !!ULTRAVOX_API_KEY
        }
    });
});

// Home route with basic information
app.get('/', (req, res) => {
    res.send('Ultravox-Twilio Integration Server. Use /incoming for incoming calls and /outgoing for outgoing calls.');
});

// Update the incoming call handler with more detailed RAG logging
app.post('/incoming', async (req, res) => {
    try {
        console.log('📞 Incoming call received:', req.body);
        const caller = req.body.From;
        const callSid = req.body.CallSid;

        console.log('🔍 Verifying RAG configuration for incoming call...');
        
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

        console.log(`Setting up incoming call ${callSid} with${corpusReady ? '' : 'out'} RAG support...`);

        const response = await createUltravoxCall({
            isOutbound: false,
            systemPrompt: process.env.INBOUND_SYSTEM_PROMPT,
            agentName: AI_NAME
        });

        if (!response || !response.joinUrl) {
            throw new Error('Failed to get a valid join URL from Ultravox');
        }

        // Log the successful RAG setup
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

    } catch (error) {
        console.error('❌ Error handling incoming call:', error);
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
        
        if (!TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
            return res.status(500).json({ 
                error: 'Twilio credentials not properly configured. Check TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER in .env file.' 
            });
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
            callSid: call.sid,
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
        const response = await new Promise((resolve, reject) => {
            const request = https.request(`${ULTRAVOX_API_URL.replace('/calls', '')}/voices`, {
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
                        const voices = JSON.parse(data);
                        resolve(voices);
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            request.on('error', reject);
            request.end();
        });

        res.json(response);
    } catch (error) {
        console.error('Error fetching voices:', error);
        res.status(500).json({ error: 'Failed to fetch voices' });
    }
});

// Corpus Management Endpoints
app.get('/list-corpora', async (req, res) => {
    try {
        const response = await axios({
            method: 'GET',
            url: `${ULTRAVOX_API_URL.replace('/calls', '')}/corpora`,
            headers: {
                'X-API-Key': ULTRAVOX_API_KEY
            }
        });
        
        res.json(response.data);
    } catch (error) {
        console.error('Error listing corpora:', error);
        res.status(500).json({ 
            error: 'Failed to list corpora', 
            message: error.message 
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

// Start server
app.listen(PORT, async () => {
    // Log any missing configurations first
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

    // Add a blank line before status section
    console.log('\n--- Status ---');
    
    // Log tool configuration
    const useTools = process.env.ULTRAVOX_USE_TOOLS === 'true';
    if (useTools) {
        const availableTools = Object.keys(tools);
        console.log(`🔧 Configured ${availableTools.length} Ultravox tools`);
        if (availableTools.length > 0) {
            console.log('📋 Available tools:', availableTools.join(', '));
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
});