# Gendj API
## README mostly written by copilot

## Overview

Gendj API is a Node.js backend service designed to support a web application that enables users to apply AI-driven transformations to their webcam feed in real time, referred to as "warping". This service is built with express and integrates various utilities and external services, including Prisma for database management, Stripe for payment processing, and SendGrid for email notifications.

## Features

- **AI Webcam Warping**: this is not in this repo, see https://github.com/GenDJ/GenDJ
- **Runpod Integration** The primary function of this api is to spin up runpod pods for users webcam warping sessions
- **Stripe Integration**: For handling payments
- **Clerk Integration**: For users, auth, sessions
- **SendGrid Integration**: For sending email notifications.
- **Prisma ORM**: For database management and migrations.
- **Scheduled Tasks**: Utilizes node-cron for periodic tasks, such as checking if warps are complete and turning off their corresponding pods

## Environment Setup

Before running the application, ensure the necessary environment variables are set in your `.env` file.

## Scheduled Tasks

The application periodically checks Warp entities every 5 minutes to ensure data consistency and perform necessary updates.

## Contributing

Contributions are welcome. Please follow the existing code style and submit your pull requests for review.

## License

This project is licensed under the terms of the MIT license. See the LICENSE file for details.

For more information on the project setup and dependencies, refer to the `package.json` file.
