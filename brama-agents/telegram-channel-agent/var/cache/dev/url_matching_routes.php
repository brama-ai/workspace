<?php

/**
 * This file has been auto-generated
 * by the Symfony Routing Component.
 */

return [
    false, // $matchHost
    [ // $staticRoutes
        '/api/v1/a2a' => [[['_route' => 'api_a2a', '_controller' => 'App\\Controller\\Api\\A2AController'], null, ['POST' => 0], null, false, false, null]],
        '/api/v1/manifest' => [[['_route' => 'api_manifest', '_controller' => 'App\\Controller\\Api\\ManifestController'], null, ['GET' => 0], null, false, false, null]],
        '/health' => [[['_route' => 'health', '_controller' => 'App\\Controller\\HealthController::health'], null, ['GET' => 0], null, false, false, null]],
    ],
    [ // $regexpList
        0 => '{^(?'
                .'|/_error/(\\d+)(?:\\.([^/]++))?(*:35)'
            .')/?$}sDu',
    ],
    [ // $dynamicRoutes
        35 => [
            [['_route' => '_preview_error', '_controller' => 'error_controller::preview', '_format' => 'html'], ['code', '_format'], null, null, false, true, null],
            [null, null, null, null, false, false, 0],
        ],
    ],
    null, // $checkCondition
];
