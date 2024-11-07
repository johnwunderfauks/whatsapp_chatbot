const { env } = process;

// Default message when the user sends an unknown message.
const unknownCommandMessage = `Sorry, I don't understand that command. Please try again by replying with one of the available options.`;

// Default welcome message
const welcomeMessage = `Hello! 👋 Welcome to our purchase verification and loyalty chatbot. We are here to help you manage your receipts and loyalty rewards. Let's get started!`;

// Default help message
const defaultMessage = `Here’s what you can do with this chatbot:

1️⃣ Upload a receipt for proof of purchase.
2️⃣ Check your purchase history.
3️⃣ Access loyalty points and rewards.
4️⃣ Get in touch with a support agent.

Type *help* to see this message again.
`;

// Chatbot config
module.exports = {
  // Optional. Specify the Wassenger device ID (24 characters hexadecimal length) to be used for the chatbot
  // If no device is defined, the first connected device will be used
  // Obtain the device ID in the Wassenger app: https://app.wassenger.com/number
  device: env.DEVICE || '66b0336fabe629577544bcfc',

  // Required. Specify the Wassenger API key to be used
  // You can obtain it here: https://app.wassenger.com/apikeys
  apiKey: env.API_KEY || '5f2b52671403b58ca545168a08bc6f9fde60ca1047c12f29bb4cb0bf07aa421117ded281ee39efef',

  // Optional. HTTP server TCP port to be used. Defaults to 8080
  port: +env.PORT || 8080,

  // Optional. Use NODE_ENV=production to run the chatbot in production mode
  production: env.NODE_ENV === 'production',

  // Optional. Specify the webhook public URL to be used for receiving webhook events
  // If no webhook is specified, the chatbot will automatically create an Ngrok tunnel
  // and register it as the webhook URL.
  webhookUrl: env.WEBHOOK_URL || 'https://4a6f-2405-9800-bca0-41e2-31cf-6554-67a1-5a64.ngrok-free.app',

  // Ngrok tunnel authentication token.
  // Required if webhook URL is not provided.
  // sign up for free and get one: https://ngrok.com/signup
  // Learn how to obtain the auth token: https://ngrok.com/docs/agent/#authtokens
  ngrokToken: env.NGROK_TOKEN,

  // Set one or multiple labels on chatbot-managed chats
  setLabelsOnBotChats: ['bot'],

  // Remove labels when the chat is assigned to a person
  removeLabelsAfterAssignment: true,

  // Set one or multiple labels on chatbot-managed chats
  setLabelsOnUserAssignment: ['from-bot'],

  // Optional. Set a list of labels that will tell the chatbot to skip it
  skipChatWithLabels: ['no-bot'],

  // Optional. Ignore processing messages sent by one of the following numbers
  // Important: the phone number must be in E164 format with no spaces or symbols
  numbersBlacklist: [],

  // Optional. Only process messages one of the the given phone numbers
  // Important: the phone number must be in E164 format with no spaces or symbols
  numbersWhitelist: [],

  // Skip chats that were archived in WhatsApp
  skipArchivedChats: true,

  // If true, when the user requests to chat with a human, the bot will assign
  // the chat to a random available team member.
  // You can specify which members are eligible to be assigned using the `teamWhitelist`
  // and which should be ignored using `teamBlacklist`
  enableMemberChatAssignment: true,

  // If true, chats assigned by the bot will be only assigned to team members that are
  // currently available and online (not unavailable or offline)
  assignOnlyToOnlineMembers: false,

  // Optional. Skip specific user roles from being automatically assigned by the chat bot
  // Available roles are: 'admin', 'supervisor', 'agent'
  skipTeamRolesFromAssignment: ['admin'], // 'supervisor', 'agent'

  // Enter the team member IDs (24 characters length) that can be eligible to be assigned
  // If the array is empty, all team members except the one listed in `skipMembersForAssignment`
  // will be eligible for automatic assignment
  teamWhitelist: [],

  // Optional. Enter the team member IDs (24 characters length) that should never be automatically assigned chats to
  teamBlacklist: [],

  // Optional. Set metadata entries on bot-assigned chats
  setMetadataOnBotChats: [
    {
      key: 'bot_start',
      value: () => new Date().toISOString()
    }
  ],

  // Optional. Set metadata entries when a chat is assigned to a team member
  setMetadataOnAssignment: [
    {
      key: 'bot_stop',
      value: () => new Date().toISOString()
    }
  ],

  welcomeMessage,
  defaultMessage,
  unknownCommandMessage
};