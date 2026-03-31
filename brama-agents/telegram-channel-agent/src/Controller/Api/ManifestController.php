<?php

declare(strict_types=1);

namespace App\Controller\Api;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;

final class ManifestController extends AbstractController
{
    #[Route('/api/v1/manifest', name: 'api_manifest', methods: ['GET'])]
    public function __invoke(): JsonResponse
    {
        return $this->json([
            'name' => 'telegram-channel-agent',
            'version' => '1.0.0',
            'description' => 'Telegram channel integration for Brama platform',
            'url' => 'http://telegram-channel-agent/api/v1/a2a',
            'provider' => [
                'organization' => 'AI Community Platform',
                'url' => 'https://github.com/nmdimas/ai-community-platform',
            ],
            'capabilities' => [
                'streaming' => false,
                'pushNotifications' => false,
            ],
            'defaultInputModes' => ['application/json'],
            'defaultOutputModes' => ['application/json'],
            'skills' => [
                [
                    'id' => 'channel.normalizeInbound',
                    'name' => 'Normalize Inbound',
                    'description' => 'Parse raw Telegram webhook update into a NormalizedEvent',
                    'tags' => ['channel', 'telegram', 'inbound'],
                ],
                [
                    'id' => 'channel.sendOutbound',
                    'name' => 'Send Outbound',
                    'description' => 'Send a message via Telegram Bot API',
                    'tags' => ['channel', 'telegram', 'outbound'],
                ],
                [
                    'id' => 'channel.validateWebhook',
                    'name' => 'Validate Webhook',
                    'description' => 'Verify X-Telegram-Bot-Api-Secret-Token header',
                    'tags' => ['channel', 'telegram', 'webhook'],
                ],
                [
                    'id' => 'channel.getCapabilities',
                    'name' => 'Get Capabilities',
                    'description' => 'Report Telegram channel capabilities',
                    'tags' => ['channel', 'telegram', 'capabilities'],
                ],
                [
                    'id' => 'channel.adminAction',
                    'name' => 'Admin Action',
                    'description' => 'Telegram-specific admin operations: test-connection, set-webhook, delete-webhook, webhook-info',
                    'tags' => ['channel', 'telegram', 'admin'],
                ],
                [
                    'id' => 'channel.hitl.pollQuestions',
                    'name' => 'HITL Poll Questions',
                    'description' => 'Monitor pipeline tasks for waiting_answer state and send questions via Telegram',
                    'tags' => ['channel', 'telegram', 'hitl'],
                ],
                [
                    'id' => 'channel.hitl.handleAnswer',
                    'name' => 'HITL Handle Answer',
                    'description' => 'Receive callback answer, write to qa.json, trigger foundry resume-qa',
                    'tags' => ['channel', 'telegram', 'hitl'],
                ],
            ],
            'channel_type' => 'telegram',
            'permissions' => [],
            'commands' => [],
            'events' => [],
            'health_url' => 'http://telegram-channel-agent/health',
        ]);
    }
}
