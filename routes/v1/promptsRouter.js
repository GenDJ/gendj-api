import express from 'express';
import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node';
import { appPrismaClient } from '#root/utils/prismaUtils.js';
import { Prisma } from '@prisma/client';

const promptsRouter = express.Router({ mergeParams: true });

// create a new prompt
promptsRouter.post('/', ClerkExpressRequireAuth(), async (req, res) => {
  const { title, prompt, postText } = req.body;
  const { userId } = req.auth;

  if (!title || !prompt) {
    return res.status(400).json({ error: 'Title and prompt are required' });
  }

  appPrismaClient.prompt
    .create({
      data: {
        createdBy: { connect: { id: userId } },
        title,
        prompt,
        postText,
      },
    })
    .then(prompt => {
      res.json({ success: true, entities: { prompts: [prompt] } });
    })
    .catch(error => {
      res.status(500).json({ error: error.message });
    });
});

// get all prompts for the current user
promptsRouter.get('/', ClerkExpressRequireAuth(), async (req, res) => {
  const { userId } = req.auth;

  appPrismaClient.prompt
    .findMany({
      where: {
        createdBy: { id: userId },
        deletedAt: null,
      },
      orderBy: {
        createdAt: 'desc', // or 'asc' if you prefer
      },
    })
    .then(prompts => {
      return res.json({ success: true, entities: { prompts: prompts } });
    })
    .catch(error => {
      res.status(500).json({ error: error.message });
    });
});

// delete a prompt
promptsRouter.delete(
  '/:promptId',
  ClerkExpressRequireAuth(),
  async (req, res) => {
    const { promptId } = req.params;
    const { userId } = req.auth;

    try {
      // Check if promptId is a valid CUID
      if (!promptId) {
        return res.status(400).json({ error: 'prompt ID required' });
      }

      // First, find the prompt and check if the user is the creator
      const prompt = await appPrismaClient.prompt.findUnique({
        where: {
          id: promptId,
        },
        include: {
          createdBy: true,
        },
      });

      if (!prompt) {
        return res.status(404).json({ error: 'Prompt not found' });
      }

      if (prompt?.createdBy?.id !== userId) {
        return res
          .status(403)
          .json({ error: 'You are not authorized to delete this prompt' });
      }

      // If the user is the creator, proceed with the deletion
      await appPrismaClient.prompt.update({
        where: {
          id: promptId,
        },
        data: {
          deletedAt: new Date(),
        },
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting prompt:', error);
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },
);

export default promptsRouter;
