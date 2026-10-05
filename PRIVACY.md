# Privacy Policy — gmail-mcp

_Last updated: 2026-10-05_

gmail-mcp is a self-hosted, personal tool. It is run by the account owner on
their own machine and is not offered as a service to anyone else.

- **Data accessed:** Gmail messages/labels (`gmail.modify`) and Google Calendar
  events (`calendar`) of the account that authorized it, only when the
  operator's MCP client requests it.
- **Storage:** OAuth credentials (`credentials.json`, `token.json`) are stored
  only on the operator's own machine. Email and calendar content is not stored
  or logged by gmail-mcp.
- **Sharing:** No data is sent to the developer or any third party. Data goes
  only between Google's APIs and the operator's own MCP client.
- **Revoking access:** Remove the app at https://myaccount.google.com/permissions
  and delete `token.json`.

Google API use complies with the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.
