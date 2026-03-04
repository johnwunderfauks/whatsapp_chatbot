export function decideNext({ body, type, chatState }) {
  const text = (body || '').trim();

  const effects = {
    messages: [],          // outbound messages to send
    nextState: {},         // state updates like { expectingImage: true }
    actions: [],           // optional: non-message actions like "FETCH_PURCHASES"
  };

  if (/help/i.test(text)) {
    effects.messages.push({ message: "Here’s what you can do with this chatbot:\n\n1️⃣ ...\nType *help* to see this message again." });
    return effects;
  }

  if (/stop/i.test(text)) {
    effects.messages.push({ message: "You have exited the chatbot. Type *help* to see the available options." });
    return effects;
  }

  if (text === "1") {
    effects.messages.push({ message: "Please upload your receipt for proof of purchase." });
    effects.nextState.expectingImage = true;
    return effects;
  }

  if (text === "2") {
    effects.messages.push({ message: "Fetching your purchase history..." });
    effects.actions.push({ type: "FETCH_PURCHASE_HISTORY" });
    return effects;
  }

  if (text === "4") {
    effects.messages.push({ message: "Connecting you to a support agent..." });
    effects.actions.push({ type: "CONNECT_AGENT" });
    return effects;
  }

  if (type === "image") {
    if (chatState?.expectingImage) {
      effects.nextState.expectingImage = false;
      effects.actions.push({ type: "PROCESS_RECEIPT_IMAGE" });
      effects.messages.push({ message: "Thank you for uploading the image. Your receipt has been uploaded successfully." });
      return effects;
    }
    effects.messages.push({ message: "Please type *1* first, then upload your receipt image." });
    return effects;
  }

  // fallback
  effects.messages.push({ message: "Type *help* to see available options." });
  return effects;
}