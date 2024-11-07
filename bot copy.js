const express = require('express')
const axios = require('axios')
const ngrok = require('ngrok')
const moment = require('moment')
const nodemon = require('nodemon')
const bodyParser = require('body-parser')
const config = require('./config')
const { env } = process
const FormData = require('form-data'); // Make sure to require this package



// Base URL API endpoint. Do not edit!
const API_URL = env.API_URL || 'https://api.wassenger.com/v1'

// Create web server
const app = express()

// Middleware to parse incoming request bodies
app.use(bodyParser.json())

// Index route
app.get('/', (req, res) => {
  res.send({
    name: 'chatbot',
    description: 'Simple WhatsApp chatbot for Wassenger',
    endpoints: {
      webhook: {
        path: '/webhook',
        method: 'POST'
      },
      sendMessage: {
        path: '/message',
        method: 'POST'
      },
      sample: {
        path: '/sample',
        method: 'GET'
      }
    }
  })
})

// POST route to handle incoming webhook messages
app.post('/webhook', (req, res) => {
  const { body } = req
  if (!body || !body.event || !body.data) {
    return res.status(400).send({ message: 'Invalid payload body' })
  }
  if (body.event !== 'message:in:new') {
    return res.status(202).send({ message: 'Ignore webhook event: only message:in:new is accepted' })
  }

  res.send({ ok: true })

  // Process message in background
  processMessage(body).catch(err => {
    console.error('[error] failed to process inbound message:', body.id, body.data.fromNumber, body.data.body, err)
  })
})

app.post('/message', (req, res) => {
  const { body } = req;
  if (!body || !body.phone || !body.message) {
    return res.status(400).send({ message: 'Invalid payload body' });
  }

  console.log('Sending message with payload:', body);

  sendMessage(body)
    .then((data) => {
      console.log('API response:', data);
      res.send(data);
    })
    .catch(err => {
      console.error('Error sending message:', err);
      res.status(+err.status || 500).send(err.response ? err.response.data : {
        message: 'Failed to send message'
      });
    });
});

// Send a sample message to your own number, or to a number specified in the query string
app.get('/sample', (req, res) => {
  const { phone, message } = req.query
  const data = {
    phone: phone || app.device.phone,
    message: message || 'Hello World from Wassenger!',
    device: app.device.id
  }
  sendMessage(data).then((data) => {
    res.send(data)
  }).catch(err => {
    res.status(+err.status || 500).send(err.response ? err.response.data : {
      message: 'Failed to send sample message'
    })
  })
})

app.use((err, req, res, next) => {
  res.status(+err.status || 500).send({
    message: `Unexpected error: ${err.message}`
  })
})

// In-memory store for a simple state machine per chat
// You can use a database instead for persistence
const state = {}
const reminders = {}

// In-memory cache store
const cache = {}
const cacheTTL = 10 * 60 * 1000 // 10 min

async function pullMembers(device) {
  if (cache.members && +cache.members.time && (Date.now() - +cache.members.time) < cacheTTL) {
    return cache.members.data
  }
  const url = `${API_URL}/devices/${device.id}/team`
  const { data: members } = await axios.get(url, { headers: { Authorization: config.apiKey } })
  cache.members = { data: members, time: Date.now() }
  return members
}

async function validateMembers(device, members) {
  const validateMembers = (config.teamWhitelist || []).concat(config.teamBlacklist || [])
  for (const id of validateMembers) {
    if (typeof id !== 'string' || string.length !== 24) {
      return exit('Team user ID in config.teamWhitelist and config.teamBlacklist must be a 24 characters hexadecimal value:', id)
    }
    const exists = members.some(user => user.id === id)
    if (!exists) {
      return exit('Team user ID in config.teamWhitelist or config.teamBlacklist does not exist:', id)
    }
  }
}

async function createLabels(device) {
  const labels = cache.labels.data || []
  const requiredLabels = (config.setLabelsOnUserAssignment || []).concat(config.setLabelsOnBotChats || [])
  const missingLabels = requiredLabels.filter(label => labels.every(l => l.name !== label))
  for (const label of missingLabels) {
    console.log('[info] creating missing label:', label)
    const url = `${API_URL}/devices/${device.id}/labels`
    const body = {
      name: label.slice(0, 30).trim(),
      color: [
        'tomato', 'orange', 'sunflower', 'bubble',
        'rose', 'poppy', 'rouge', 'raspberry',
        'purple', 'lavender', 'violet', 'pool',
        'emerald', 'kelly', 'apple', 'turquoise',
        'aqua', 'gold', 'latte', 'cocoa'
      ][Math.floor(Math.random() * 20)],
      description: 'Automatically created label for the chatbot'
    }
    try {
      await axios.post(url, body, { headers: { Authorization: config.apiKey } })
    } catch (err) {
      console.error('[error] failed to create label:', label, err.message)
    }
  }
  if (missingLabels.length) {
    await pullLabels(device, { force: true })
  }
}

async function pullLabels(device, { force } = {}) {
  if (!force && cache.labels && +cache.labels.time && (Date.now() - +cache.labels.time) < cacheTTL) {
    return cache.labels.data
  }
  const url = `${API_URL}/devices/${device.id}/labels`
  const { data: labels } = await axios.get(url, { headers: { Authorization: config.apiKey } })
  cache.labels = { data: labels, time: Date.now() }
  return labels
}

async function updateChatLabels({ data, device, labels }) {
  const url = `${API_URL}/chat/${device.id}/chats/${data.chat.id}/labels`
  const newLabels = (data.chat.labels || [])
  for (const label of labels) {
    if (newLabels.includes(label)) {
      newLabels.push(label)
    }
  }
  if (newLabels.length) {
    console.log('[info] update chat labels:', data.chat.id, newLabels)
    await axios.patch(url, newLabels, { headers: { Authorization: config.apiKey } })
  }
}

async function updateChatMetadata({ data, device, metadata }) {
  const url = `${API_URL}/chat/${device.id}/contacts/${data.chat.id}/metadata`
  const entries = []
  const contactMetadata = data.chat.contact.metadata
  for (const entry of metadata) {
    if (entry && entry.key && entry.value) {
      const value = typeof entry.value === 'function' ? entry.value() : value
      if (!entry.key || !value || typeof entry.key !== 'string' || typeof value !== 'string') {
        continue
      }
      if (contactMetadata && contactMetadata.some(e => e.key === entry.key && e.value === value)) {
        continue // skip if metadata entry is already present
      }
      entries.push({
        key: entry.key.slice(0, 30).trim(),
        value: value.slice(0, 1000).trim()
      })
    }
  }
  if (entries.length) {
    await axios.patch(url, entries, { headers: { Authorization: config.apiKey } })
  }
}

async function selectAssignMember(device) {
  const members = await pullMembers(device)

  const isMemberEligible = (member) => {
    if (config.teamBlacklist.length && config.teamBlacklist.includes(member.id)) {
      return false
    }
    if (config.teamWhitelist.length && !config.teamWhitelist.includes(member.id)) {
      return false
    }
    if (config.assignOnlyToOnlineMembers && (member.availability.mode !== 'auto' || ((Date.now() - +new Date(member.lastSeenAt)) > 30 * 60 * 1000))) {
      return false
    }
    if (config.skipTeamRolesFromAssignment && config.skipTeamRolesFromAssignment.some(role => member.role === role)) {
      return false
    }
    return true
  }

  const activeMembers = members.filter(member => member.status === 'active' && isMemberEligible(member))
  if (!activeMembers.length) {
    return console.log('[warning] Unable to assign chat: no eligible team members')
  }

  const targetMember = activeMembers[activeMembers.length * Math.random() | 0]
  return targetMember
}

async function assignChat({ member, data, device }) {
  const url = `${API_URL}/chat/${device.id}/chats/${data.chat.id}/owner`
  const body = { agent: member.id }
  await axios.patch(url, body, { headers: { Authorization: config.apiKey } })

  if (config.setMetadataOnAssignment && config.setMetadataOnAssignment.length) {
    const metadata = config.setMetadataOnAssignment.filter(entry => entry && entry.key && entry.value).map(({ key, value }) => ({ key, value }))
    await updateChatMetadata({ data, device, metadata })
  }
}

async function assignChatToAgent({ data, device }) {
  if (!config.enableMemberChatAssignment) {
    return console.log('[debug] Unable to assign chat: member chat assignment is disabled. Enable it in config.enableMemberChatAssignment = true')
  }
  try {
    const member = await selectAssignMember(device)
    if (member) {
      let updateLabels = []

      // Remove labels before chat assigned, if required
      if (config.removeLabelsAfterAssignment && config.setLabelsOnBotChats && config.setLabelsOnBotChats.length) {
        const labels = (data.chat.labels || []).filter(label => !config.setLabelsOnBotChats.includes(label))
        console.log('[info] remove labels before assiging chat to user', data.chat.id, labels)
        if (labels.length) {
          updateLabels = labels
        }
      }

      // Set labels on chat assignment, if required
      if (config.setLabelsOnUserAssignment && config.setLabelsOnUserAssignment.length) {
        let labels = (data.chat.labels || [])
        if (updateLabels.length) {
          labels = labels.filter(label => !updateLabels.includes(label))
        }
        for (const label of config.setLabelsOnUserAssignment) {
          if (!updateLabels.includes(label)) {
            updateLabels.push(label)
          }
        }
      }

      if (updateLabels.length) {
        console.log('[info] set labels on chat assignment to user', data.chat.id, updateLabels)
        await updateChatLabels({ data, device, labels: updateLabels })
      }

      console.log('[info] automatically assign chat to user:', data.chat.id, member.displayName, member.email)
      await assignChat({ member, data, device })
    } else {
      console.log('[info] Unable to assign chat: no eligible or available team members based on the current configuration:', data.chat.id)
    }
    return member
  } catch (err) {
    console.error('[error] failed to assign chat:', data.id, data.chat.id, err)
  }
}

async function unassignChat({ data, device }) {
  try {
    const url = `${API_URL}/chat/${device.id}/chats/${data.chat.id}/owner`
    await axios.delete(url, null, { headers: { Authorization: config.apiKey } })
  } catch (err) {
    console.error('[error] failed to unassign chat:', data.id, data.chat.id, err)
  }
}

function canReply({ data, device }) {
  const { chat } = data

  // Skip if chat is already assigned to an team member
  if (chat.owner && chat.owner.agent) {
    return false
  }

  // Ignore messages from group chats
  if (chat.type !== 'chat') {
    return false
  }

  // Skip replying chat if it has one of the configured labels, when applicable
  if (config.skipChatWithLabels && config.skipChatWithLabels.length && chat.labels && chat.labels.length) {
    if (config.skipChatWithLabels.some(label => chat.labels.includes(label))) {
      return false
    }
  }

  // Only reply to chats that were whitelisted, when applicable
  if (config.numbersWhitelist && config.numbersWhitelist.length && chat.fromNumber) {
    if (config.numbersWhitelist.some(number => number === chat.fromNumber || chat.fromNumber.slice(1) === number)) {
      return true
    } else {
      return false
    }
  }

  // Skip replying to chats that were explicitly blacklisted, when applicable
  if (config.numbersBlacklist && config.numbersBlacklist.length && chat.fromNumber) {
    if (config.numbersBlacklist.some(number => number === chat.fromNumber || chat.fromNumber.slice(1) === number)) {
      return false
    }
  }

  // Skip replying chats that were archived, when applicable
  if (config.skipArchivedChats && (chat.status === 'archived' || chat.waStatus === 'archived')) {
    return false
  }

  // Always ignore replying to banned chats/contacts
  if ((chat.status === 'banned' || chat.waStatus === 'banned  ')) {
    return false
  }

  return true
}

const fs = require('fs');
const path = require('path');

// Logging function to write logs to an external file
function logToFile(message) {
  const logPath = path.resolve(__dirname, 'chatbot_logs.txt');
  const logMessage = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(logPath, logMessage, 'utf8');
}

const chatStateStore = new Map();

// Fetch chat state from the store
async function getChatState(chatId) {
  return chatStateStore.get(chatId) || {};
}

// Update chat state in the store
async function updateChatState(chatId, update) {
  const currentState = chatStateStore.get(chatId) || {};
  chatStateStore.set(chatId, { ...currentState, ...update });
}


async function processMessage({ data, device } = {}) {
  // Log the entire incoming data object for debugging purposes
  logToFile(`[info] Received message data: ${JSON.stringify(data)}`);

  // Can reply to this message?
  if (!canReply({ data, device })) {
    return logToFile(`[info] Skip message due to chat already assigned or not eligible to reply: ${data.fromNumber}, ${data.date}, ${data.body}`);
  }

  const { chat, type } = data;
  let { body } = data;

  if (body) {
    body = body.trim();
  }

  const { phone } = chat.contact;
  logToFile(`[info] New inbound message received: ${chat.id}, Type: ${type}, Body: ${body || '<empty message>'}`);

  const reply = async ({ message, ...params }) => {
    await sendMessage({
      phone,
      device: device.id,
      message,
      ...params
    });
  };

  // Default message
  const defaultMessage = `Here’s what you can do with this chatbot:

  1️⃣ Upload a receipt for proof of purchase.
  2️⃣ Check your purchase history.
  3️⃣ Access loyalty points and rewards.
  4️⃣ Get in touch with a support agent.

  Type *help* to see this message again.`;

  // Handle help and stop commands
  if (/help/i.test(body)) {
    return await reply({ message: defaultMessage });
  }

  if (/stop/i.test(body)) {
    return await reply({ message: 'You have exited the chatbot. Type *help* to see the available options.' });
  }

  // Handle the four main commands
  if (body === '1') {
    await reply({ message: 'Please upload your receipt for proof of purchase.' });

    // Set a flag to expect an image upload
    await updateChatState(chat.id, { expectingImage: true });
    logToFile(`[info] Set expectingImage to true for chat ID: ${chat.id}`);
    return;
  }

  if (body === '2') {
    return await reply({ message: 'Fetching your purchase history...' });
  }

  if (body === '3') {
    return await reply({ message: 'Here are your loyalty points and rewards...' });
  }

  if (body === '4') {
    return await reply({ message: 'Connecting you to a support agent...' });
  }

  // Handle image messages
  if (type === 'image') {
    const chatState = await getChatState(chat.id);
    logToFile(`[info] Received image message, expectingImage flag is: ${chatState.expectingImage}`);

    if (chatState.expectingImage) {
      await updateChatState(chat.id, { expectingImage: false });

      if (data.media && data.media.id) {
        logToFile(`[info] Processing image with ID: ${data.media.id}`);

        try {
          const image = await fetchImageFromWassenger(data.media.id);

          const filePath = path.resolve(__dirname, 'temp_image.jpg');
          fs.writeFileSync(filePath, image);

          const imageUrl = await uploadImageToWordPress(filePath);

          fs.unlinkSync(filePath);

          return await reply({ message: `Thank you for uploading the image. Your receipt has been uploaded successfully: ${imageUrl}` });
        } catch (error) {
          logToFile(`Error processing image: ${error.message}`);
          return await reply({ message: 'There was an error processing your image. Please try again.' });
        }
      } else {
        logToFile('No image data found.');
        return await reply({ message: 'No image data found. Please try uploading again.' });
      }
    } else {
      logToFile('Image received but expectingImage flag was not set.');
    }
  }

  // Default to unknown command response
  await reply({ message: defaultMessage });
}

// Fetch image data from Wassenger
async function fetchImageFromWassenger(mediaId) {
  const url = `https://api.wassenger.com/v1/chat/66b0336fabe629577544bcfc/files/${mediaId}/download`;
  const options = {
    method: 'GET',
    url: url,
    headers: {
      'Content-Type': 'application/json',
      Token: '5f2b52671403b58ca545168a08bc6f9fde60ca1047c12f29bb4cb0bf07aa421117ded281ee39efef'
    },
    responseType: 'arraybuffer' // Get image as a binary buffer
  };

  logToFile(`[info] Fetching image from URL: ${url}`);

  try {
    const response = await axios.request(options);
    return response.data; // Return the image binary data
  } catch (error) {
    logToFile(`Error fetching image data from URL ${url}: ${error}`);
    throw new Error('Failed to fetch image from Wassenger');
  }
}

// Upload the image to WordPress
async function uploadImageToWordPress(filePath) {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(filePath));
  formData.append('title', 'Receipt Upload');
  formData.append('alt_text', 'Uploaded receipt');
  formData.append('description', 'Receipt image uploaded by user');

  try {
    const response = await axios({
      method: 'POST',
      url: 'http://whatsapp-chatbot.local/wp-json/custom/v1/upload',
      headers: {
        'Authorization': `Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJodHRwOi8vd2hhdHNhcHAtY2hhdGJvdC5sb2NhbCIsImlhdCI6MTcyMzM1MTEyNiwibmJmIjoxNzIzMzUxMTI2LCJleHAiOjE3MjM5NTU5MjYsImRhdGEiOnsidXNlciI6eyJpZCI6IjEifX19.mrCfzByGY49Rua2LkAfbOrAK34enwBQFai2IGLJFlS0`, // Use environment variable for token
        ...formData.getHeaders()
      },
      data: formData
    });

    if (response.status === 200) {
      // return response.data.url; // Return the URL of the uploaded image
      return 'We will get in touch soon.';
    } else {
      logToFile(`Error uploading image: ${JSON.stringify(response.data)}`);
      throw new Error('Failed to upload image to WordPress');
    }
  } catch (error) {
    logToFile(`Error uploading image to WordPress: ${error}`);
    throw new Error('Error uploading image to WordPress');
  }
}

async function sendMessage({ phone, message, media, device, ...fields }) {
  const url = `${API_URL}/messages`;
  const body = {
    phone,
    message,
    media,
    device,
    ...fields,
    enqueue: 'never'
  };

  let retries = 3;
  while (retries) {
    retries -= 1;
    try {
      const res = await axios.post(url, body, {
        headers: { Authorization: config.apiKey }
      });
      console.log('[info] Message sent:', phone, res.data.id, res.data.status);
      return res.data;
    } catch (err) {
      console.error('[error] failed to send message:', phone, message || (body.list ? body.list.description : '<no message>'), err.response ? err.response.data : err);
    }
  }
  return false;
}

// Find an active WhatsApp device connected to the Wassenger API
async function loadDevice() {
  const url = `${API_URL}/devices`
  const { data } = await axios.get(url, {
    headers: { Authorization: config.apiKey }
  })
  if (config.device && !config.device.includes(' ')) {
    if (/^[a-f0-9]{24}$/i.test(config.device) === false) {
      return exit('Invalid WhatsApp device ID: must be 24 characers hexadecimal value. Get the device ID here: https://app.wassenger.com/number')
    }
    return data.find(device => device.id === config.device)
  }
  return data.find(device => device.status === 'operative')
}

// Function to register a Ngrok tunnel webhook for the chatbot
// Only used in local development mode
async function registerWebhook(tunnel, device) {
  const webhookUrl = `${tunnel}/webhook`

  const url = `${API_URL}/webhooks`
  const { data: webhooks } = await axios.get(url, {
    headers: { Authorization: config.apiKey }
  })

  const findWebhook = webhook => {
    return (
      webhook.url === webhookUrl &&
      webhook.device === device.id &&
      webhook.status === 'active' &&
      webhook.events.includes('message:in:new')
    )
  }

  // If webhook already exists, return it
  const existing = webhooks.find(findWebhook)
  if (existing) {
    return existing
  }

  for (const webhook of webhooks) {
    // Delete previous ngrok webhooks
    if (webhook.url.includes('ngrok-free.app') || webhook.url.startsWith(tunnel)) {
      const url = `${API_URL}/webhooks/${webhook.id}`
      await axios.delete(url, { headers: { Authorization: config.apiKey } })
    }
  }

  await new Promise(resolve => setTimeout(resolve, 500))
  const data = {
    url: webhookUrl,
    name: 'Chatbot',
    events: ['message:in:new'],
    device: device.id
  }

  const { data: webhook } = await axios.post(url, data, {
    headers: { Authorization: config.apiKey }
  })

  return webhook
}

// Function to create a Ngrok tunnel and register the webhook dynamically
async function createTunnel() {
  let retries = 3

  while (retries) {
    retries -= 1
    try {
      const tunnel = await ngrok.connect({
        addr: config.port,
        authtoken: config.ngrokToken
      })
      console.log(`Ngrok tunnel created: ${tunnel}`)
      return tunnel
    } catch (err) {
      console.error('[error] Failed to create Ngrok tunnel:', err.message)
      await ngrok.kill()
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }

  throw new Error('Failed to create Ngrok tunnel')
}

async function devServer() {
  const tunnel = await createTunnel();

  nodemon({
    script: 'bot.js',
    ext: 'js',
    watch: ['*.js', 'src/**/*.js'],
    exec: `WEBHOOK_URL=${tunnel} DEV=false npm run start`,
  }).on('restart', () => {
    console.log('[info] Restarting bot after changes...');
  }).on('quit', () => {
    console.log('[info] Closing bot...');
    ngrok.kill().then(() => process.exit(0));
  });
}

function exit(msg, ...args) {
  console.error('[error]', msg, ...args)
  process.exit(1)
}

// Initialize chatbot server
async function main() {
  // API key must be provided
  if (!config.apiKey || config.apiKey.length < 60) {
    return exit('Please sign up in Wassenger and obtain your API key here:\nhttps://app.wassenger.com/apikeys')
  }

  // Create dev mode server with Ngrok tunnel and nodemon
  if (env.DEV === 'true' && !config.production) {
    return devServer()
  }

  // Find a WhatsApp number connected to the Wassenger API
  const device = await loadDevice()
  if (!device) {
    return exit('No active WhatsApp numbers in your account. Please connect a WhatsApp number in your Wassenger account:\nhttps://app.wassenger.com/create')
  }
  if (device.session.status !== 'online') {
    return exit(`WhatsApp number (${device.alias}) is not online. Please make sure the WhatsApp number in your Wassenger account is properly connected:\nhttps://app.wassenger.com/${device.id}/scan`)
  }
  if (device.billing.subscription.product !== 'io') {
    return exit(`WhatsApp number plan (${device.alias}) does not support inbound messages. Please upgrade the plan here:\nhttps://app.wassenger.com/${device.id}/plan?product=io`)
  }

  // Pre-load device labels and team mebers
  const [members] = await Promise.all([
    pullMembers(device),
    pullLabels(device)
  ])

  // Create labels if they don't exist
  await createLabels(device)

  // Validate whitelisted and blacklisted members exist
  await validateMembers(members)

  app.device = device
  console.log('[info] Using WhatsApp connected number:', device.phone, device.alias, `(ID = ${device.id})`)

  // Start server
  await app.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`)
  })

  if (config.production) {
    console.log('[info] Validating webhook endpoint...')
    if (!config.webhookUrl) {
      return exit('Missing required environment variable: WEBHOOK_URL must be present in production mode')
    }
    const webhook = await registerWebhook(config.webhookUrl, device)
    if (!webhook) {
      return exit(`Missing webhook active endpoint in production mode: please create a webhook endpoint that points to the chatbot server:\nhttps://app.wassenger.com/${device.id}/webhooks`)
    }
    console.log('[info] Using webhook endpoint in production mode:', webhook.url)
  } else {
    console.log('[info] Registering webhook tunnel...')
    const tunnel = config.webhookUrl || await createTunnel()
    const webhook = await registerWebhook(tunnel, device)
    if (!webhook) {
      console.error('Failed to connect webhook. Please try again.')
      await ngrok.kill()
      return process.exit(1)
    }
  }

  console.log('[info] Chatbot server ready and waiting for messages!')
}

main().catch(err => {
  exit('Failed to start chatbot server:', err)
})