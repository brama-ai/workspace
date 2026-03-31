<?php

declare(strict_types=1);

namespace App\Controller\Api;

use App\A2A\TelegramChannelA2AHandler;
use Psr\Log\LoggerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

final class A2AController extends AbstractController
{
    public function __construct(
        private readonly TelegramChannelA2AHandler $handler,
        private readonly LoggerInterface $logger,
    ) {
    }

    #[Route('/api/v1/a2a', name: 'api_a2a', methods: ['POST'])]
    public function __invoke(Request $request): JsonResponse
    {
        /** @var array<string, mixed>|null $data */
        $data = json_decode($request->getContent(), true);

        if (!\is_array($data)) {
            $this->logger->warning('Invalid A2A payload received', [
                'ip' => $request->getClientIp(),
            ]);

            return $this->json(
                ['error' => 'Invalid A2A payload: JSON object expected'],
                Response::HTTP_UNPROCESSABLE_ENTITY,
            );
        }

        $skill = (string) ($data['skill'] ?? $data['intent'] ?? '');
        if ('' === $skill) {
            return $this->json(
                ['error' => 'Invalid A2A payload: skill (or intent) is required'],
                Response::HTTP_UNPROCESSABLE_ENTITY,
            );
        }

        $requestId = (string) ($data['request_id'] ?? uniqid('a2a_', true));
        $data['request_id'] = $requestId;

        $this->logger->info('A2A request received', [
            'skill' => $skill,
            'request_id' => $requestId,
        ]);

        $result = $this->handler->handle($data);

        $this->logger->info('A2A request completed', [
            'skill' => $skill,
            'status' => $result['status'] ?? 'unknown',
            'request_id' => $requestId,
        ]);

        return $this->json($result);
    }
}
