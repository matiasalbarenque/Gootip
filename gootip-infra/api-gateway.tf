locals {
  http_api_enabled = (
    var.api_preparation_enabled ||
    var.application_runtime_deployment_enabled ||
    var.core_runtime_deployment_enabled
  )

  core_api_routes = var.core_runtime_deployment_enabled ? {
    "GET /api/health"                = "public"
    "GET /api/categories"            = "public"
    "GET /api/categories/{id}"       = "public"
    "GET /api/products"              = "public"
    "GET /api/products/{id}"         = "public"
    "POST /api/categories"           = "protected"
    "PATCH /api/categories/{id}"     = "protected"
    "GET /api/admin/products"        = "protected"
    "POST /api/admin/products"       = "protected"
    "GET /api/admin/products/{id}"   = "protected"
    "PATCH /api/admin/products/{id}" = "protected"
  } : {}
}

# Preparation creates only the route-less HTTP API; its generated ID is supplied
# to bootstrap IAM before the stage and runtime routes are enabled.
resource "aws_apigatewayv2_api" "main" {
  count = local.http_api_enabled ? 1 : 0

  name          = "gootip-auth-${var.env}"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins     = [var.frontend_url]
    allow_methods     = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_headers     = ["Content-Type", "Authorization"]
    allow_credentials = true
  }

  tags = {
    Name       = "gootip-auth-${var.env}"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_apigatewayv2_integration" "auth" {
  count = var.application_runtime_deployment_enabled ? 1 : 0

  api_id                 = aws_apigatewayv2_api.main[0].id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = aws_lambda_function.gootip_auth[0].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "core" {
  count = var.core_runtime_deployment_enabled ? 1 : 0

  api_id                 = aws_apigatewayv2_api.main[0].id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = aws_lambda_function.gootip_core[0].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  count = var.core_runtime_deployment_enabled ? 1 : 0

  api_id           = aws_apigatewayv2_api.main[0].id
  name             = "gootip-${var.env}-auth-jwt"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer   = var.better_auth_url
    audience = [var.jwt_audience]
  }
}

resource "aws_apigatewayv2_route" "auth_root" {
  count = var.application_runtime_deployment_enabled ? 1 : 0

  api_id             = aws_apigatewayv2_api.main[0].id
  route_key          = "ANY /api/auth"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.auth[0].id}"
}

resource "aws_apigatewayv2_route" "auth_proxy" {
  count = var.application_runtime_deployment_enabled ? 1 : 0

  api_id             = aws_apigatewayv2_api.main[0].id
  route_key          = "ANY /api/auth/{proxy+}"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.auth[0].id}"
}

resource "aws_apigatewayv2_route" "auth_discovery" {
  count = var.application_runtime_deployment_enabled ? 1 : 0

  api_id             = aws_apigatewayv2_api.main[0].id
  route_key          = "GET /.well-known/openid-configuration"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.auth[0].id}"
}

resource "aws_apigatewayv2_route" "core" {
  for_each = local.core_api_routes

  api_id             = aws_apigatewayv2_api.main[0].id
  route_key          = each.key
  authorization_type = each.value == "protected" ? "JWT" : "NONE"
  authorizer_id      = each.value == "protected" ? aws_apigatewayv2_authorizer.jwt[0].id : null
  target             = "integrations/${aws_apigatewayv2_integration.core[0].id}"
}

resource "aws_apigatewayv2_stage" "default" {
  count = (
    var.application_runtime_deployment_enabled ||
    var.core_runtime_deployment_enabled ||
    var.api_stage_enabled
  ) ? 1 : 0

  api_id      = aws_apigatewayv2_api.main[0].id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format = jsonencode({
      requestId       = "$context.requestId"
      routeKey        = "$context.routeKey"
      method          = "$context.httpMethod"
      status          = "$context.status"
      responseLength  = "$context.responseLength"
      integrationCode = "$context.integration.status"
    })
  }

  default_route_settings {
    throttling_rate_limit  = var.api_throttling_rate_limit
    throttling_burst_limit = var.api_throttling_burst_limit
  }

  tags = {
    Name       = "gootip-auth-${var.env}-default"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_lambda_permission" "auth_root" {
  count = var.application_runtime_deployment_enabled ? 1 : 0

  statement_id  = "AllowHttpApiAuthRoot"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.gootip_auth[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main[0].execution_arn}/$default/*/api/auth"
}

resource "aws_lambda_permission" "auth_proxy" {
  count = var.application_runtime_deployment_enabled ? 1 : 0

  statement_id  = "AllowHttpApiAuthProxy"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.gootip_auth[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main[0].execution_arn}/$default/*/api/auth/*"
}

resource "aws_lambda_permission" "auth_discovery" {
  count = var.application_runtime_deployment_enabled ? 1 : 0

  statement_id  = "AllowHttpApiAuthDiscovery"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.gootip_auth[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main[0].execution_arn}/$default/GET/.well-known/openid-configuration"
}

resource "aws_lambda_permission" "core_route" {
  for_each = local.core_api_routes

  statement_id  = "AllowCoreRoute${substr(sha1(each.key), 0, 12)}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.gootip_core[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn = "${aws_apigatewayv2_api.main[0].execution_arn}/$default/${split(" ", each.key)[0]}/${trimprefix(replace(
    replace(split(" ", each.key)[1], "{id}", "*"),
    "{proxy+}",
    "*",
  ), "/")}"
}
