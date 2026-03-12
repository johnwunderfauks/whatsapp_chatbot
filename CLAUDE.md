# CLAUDE.md

## Project Overview
This project is a full-stack application for whatsappchat bot, it provides and retrieves messages from twilio and let users upload receipt images via whatsapp, this bot receives receipt image, detect fraud, grab information and passess to wordpress api.

## Tech Stack
*   Backend: Node.js, Express, OpenAI, Google OCR, Wordpress API, Redis, BullQ

## Architecture
*   Frontend uses functional components and prefers server components where possible.
*   Backend is a RESTful API with a microservice architecture.
*   Folder structure is organized by feature domain.
*   Ignore /legacy

## Coding Rules
*   Use TypeScript for all new code.
*   Prefer functional components in React.
*   Ensure all code is covered by unit tests (minimum 80% coverage).
*   Avoid inline CSS; use Tailwind utilities or defined design tokens.