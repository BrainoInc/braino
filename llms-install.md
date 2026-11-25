# Install Braino in Cline

Braino is a hosted Streamable HTTP MCP server. Add this entry to Cline's MCP settings:

```json
{
  "mcpServers": {
    "braino": {
      "type": "streamableHttp",
      "url": "https://braino.dev/mcp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Do not add an `Authorization` header or ask the user for an access token. Start the server and use
Cline's OAuth action to sign in to Braino in the browser. Leave `autoApprove` empty until the user
has reviewed Braino's tools and chosen their own approval policy.

After sign-in, call `braino_whoami` to verify the account and list the workspaces and collections
available to the connection. Do not guess collection handles or claim access outside that result.
