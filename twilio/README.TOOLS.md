# Ultravox Tool System

This document explains how to use the modular tool system with Ultravox in this integration.

## Overview

The tool system allows you to:

1. Define tools in configuration or environment variables
2. Enable or disable tools without changing code
3. Use both permanent and temporary tools
4. Configure tools through environment variables
5. Register tools with Ultravox API 

## Configuration

Tools can be configured in several ways:

1. **Built-in tools**: Predefined in `config/tools.js`
2. **Environment variables**: Define tools directly in `.env` file
3. **Custom configuration**: Add new tools to `config/tools.js`

## Environment Variables

Add these to your `.env` file (see `.env.tools` for examples):

| Variable | Description | Example |
|----------|-------------|---------|
| `ULTRAVOX_USE_TOOLS` | Enable/disable the entire tool system | `true` |
| `ULTRAVOX_USE_PERMANENT_TOOLS` | Use registered tools vs temporary inline definitions | `false` |
| `ULTRAVOX_ENABLED_TOOLS` | Comma-separated list of tools to enable | `blockexplorer,weather` |
| `ULTRAVOX_CALL_TOOLS` | Tools to include in each call (empty = all enabled) | `blockexplorer` |
| `ULTRAVOX_TOOLS_TO_REGISTER` | Tools to register with setup script | `blockexplorer` |

## Defining Custom Tools

You can define up to 10 custom tools in your `.env` file:

```
# Tool #1
ULTRAVOX_TOOL_1_NAME=weather
ULTRAVOX_TOOL_1_DESCRIPTION=Get current weather for a location
ULTRAVOX_TOOL_1_URL=https://api.weather.com/current
ULTRAVOX_TOOL_1_METHOD=GET
ULTRAVOX_TOOL_1_PARAMS=[{"name":"location","location":"PARAMETER_LOCATION_QUERY","schema":{"type":"string"},"required":true}]

# Tool #2
ULTRAVOX_TOOL_2_NAME=translate
ULTRAVOX_TOOL_2_DESCRIPTION=Translate text to another language
ULTRAVOX_TOOL_2_URL=https://api.translator.com/translate
ULTRAVOX_TOOL_2_METHOD=POST
```

## Customizing Built-in Tools

Override specific properties of built-in tools:

```
# Override the API URL for blockexplorer
APGRID_PRICE_API_URL=https://custom-explorer.example.com/api/price
```

## Registering Permanent Tools

To register your tools with Ultravox API (needed if `ULTRAVOX_USE_PERMANENT_TOOLS=true`):

```bash
npm run setup-tools
```

This will register all tools specified in `ULTRAVOX_TOOLS_TO_REGISTER` (or all available tools if not specified).

## Usage in Development

1. Configure your tools in `.env` file
2. Set `ULTRAVOX_USE_TOOLS=true`
3. Set `ULTRAVOX_ENABLED_TOOLS=tool1,tool2` or `ULTRAVOX_ENABLED_TOOLS=*` for all
4. Start the server: `npm run dev`

For permanent tools:
1. Register tools: `npm run setup-tools`
2. Set `ULTRAVOX_USE_PERMANENT_TOOLS=true`

## Implementation Details

- `config/tools.js`: Central definition of all available tools
- `utils/tool-manager.js`: Utilities for working with tools in the application
- `scripts/setup-tools.js`: Script for registering tools with Ultravox API

## Example: Using the blockexplorer Tool

The `blockexplorer` tool is included by default and fetches the current price of AI Power Grid coin.

1. Enable it: `ULTRAVOX_ENABLED_TOOLS=blockexplorer`
2. Use in calls: `ULTRAVOX_CALL_TOOLS=blockexplorer`
3. In the voice call, the AI will be able to respond to queries like "What's the current price of AI Power Grid coin?" 