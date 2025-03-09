#!/usr/bin/env node

import readline from 'readline';
import fetch from 'node-fetch';
import 'dotenv/config';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';

async function makeOutboundCall(phoneNumber, systemPrompt) {
  try {
    console.log(`Initiating call to ${phoneNumber}...`);
    
    const response = await fetch(`${SERVER_URL}/outgoing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        destinationNumber: phoneNumber,
        systemPrompt
      })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      console.log('Call initiated successfully!');
      console.log(`Call SID: ${data.callSid}`);
    } else {
      console.error('Failed to initiate call:', data.error);
      console.error(data.message);
    }
  } catch (error) {
    console.error('Error making API request:', error.message);
  }
}

function promptUser() {
  rl.question('Enter phone number to call (e.g., +1234567890): ', (phoneNumber) => {
    if (!phoneNumber) {
      console.error('Phone number is required');
      return promptUser();
    }
    
    rl.question('Enter system prompt (or press Enter for default): ', (systemPrompt) => {
      makeOutboundCall(phoneNumber, systemPrompt || undefined)
        .finally(() => {
          rl.close();
        });
    });
  });
}

console.log('=== Ultravox-Twilio Outbound Call Tool ===');
promptUser(); 