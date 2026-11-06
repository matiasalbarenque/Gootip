import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error)
  throw new Error(
    ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
  );
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, {
  ...parsed.options,
  noEmit: true,
});
const checker = program.getTypeChecker();
const applicationSource = program.getSourceFile(path.join(root, 'src/app.ts'));
const apiPrefixDeclaration = applicationSource?.statements
  .filter(ts.isVariableStatement)
  .flatMap((statement) => statement.declarationList.declarations)
  .find(
    (declaration) =>
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === 'API_PREFIX',
  );
if (
  !apiPrefixDeclaration ||
  !apiPrefixDeclaration.initializer ||
  !ts.isStringLiteral(apiPrefixDeclaration.initializer)
) {
  throw new Error('Cannot resolve the Core global API prefix from src/app.ts.');
}
const apiPrefix = apiPrefixDeclaration.initializer.text;

type Field = {
  type: string;
  required: boolean;
  example: unknown;
  values?: unknown[];
};
const decorators = (node: ts.Node) =>
  ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
const decoratorName = (decorator: ts.Decorator) => {
  const expression = ts.isCallExpression(decorator.expression)
    ? decorator.expression.expression
    : decorator.expression;
  return expression.getText().split('.').at(-1);
};
const decoratorArg = (decorator: ts.Decorator) =>
  ts.isCallExpression(decorator.expression)
    ? decorator.expression.arguments[0]
    : undefined;
const stringArg = (decorator: ts.Decorator, fallback = '') => {
  const argument = decoratorArg(decorator);
  return argument && ts.isStringLiteralLike(argument)
    ? argument.text
    : fallback;
};

const typeField = (
  type: ts.Type,
  required: boolean,
  declaration?: ts.Declaration,
): Field => {
  if (type.isUnion()) {
    const relevant = type.types.filter(
      (part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
    );
    if (relevant.length === 1)
      return typeField(relevant[0]!, required, declaration);
    const values = relevant
      .filter(
        (part) =>
          (part.flags &
            (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral)) !==
          0,
      )
      .map(
        (part) => (part as ts.StringLiteralType | ts.NumberLiteralType).value,
      );
    if (values.length === relevant.length && values.length) {
      return { type: typeof values[0], required, example: values[0], values };
    }
    throw new Error(
      `Unsupported DTO union type: ${checker.typeToString(type)}`,
    );
  }
  if (checker.isArrayType(type))
    return {
      type: 'array',
      required,
      example: [
        declaration &&
        decorators(declaration).some(
          (decorator) => decoratorName(decorator) === 'IsUrl',
        )
          ? 'https://example.invalid/image.jpg'
          : 'example',
      ],
    };
  const flags = type.flags;
  if (flags & ts.TypeFlags.StringLike) {
    const name =
      declaration &&
      (ts.isPropertyDeclaration(declaration) ||
        ts.isPropertySignature(declaration))
        ? declaration.name.getText()
        : '';
    const uuid = declaration
      ? decorators(declaration).some((d) => decoratorName(d) === 'IsUUID')
      : false;
    if (name === 'priceUsd') {
      return { type: 'string', required, example: '12.34' };
    }
    if (name === 'discountPercentage') {
      return { type: 'string', required, example: '10' };
    }
    return {
      type: 'string',
      required,
      example: uuid
        ? '00000000-0000-4000-8000-000000000001'
        : `${name || 'example'}-example`,
    };
  }
  if (flags & ts.TypeFlags.NumberLike)
    return { type: 'number', required, example: 1 };
  if (flags & ts.TypeFlags.BooleanLike)
    return { type: 'boolean', required, example: false };
  throw new Error(
    `Unsupported DTO property type: ${checker.typeToString(type)}`,
  );
};

const dtoFields = (node: ts.TypeNode) => {
  const type = checker.getTypeFromTypeNode(node);
  return Object.fromEntries(
    checker.getPropertiesOfType(type).map((property) => {
      const declaration =
        property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration)
        throw new Error(`Cannot resolve DTO property ${property.name}.`);
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
      return [
        property.name,
        typeField(
          checker.getTypeOfSymbolAtLocation(property, declaration),
          !optional,
          declaration,
        ),
      ];
    }),
  );
};

export const exportCoreContracts = () => {
  const result: Record<string, unknown>[] = [];
  for (const source of program.getSourceFiles()) {
    if (!source.fileName.startsWith(path.join(root, 'src') + path.sep))
      continue;
    const controller = source.statements.find(
      (statement): statement is ts.ClassDeclaration =>
        ts.isClassDeclaration(statement) &&
        decorators(statement).some((d) => decoratorName(d) === 'Controller'),
    );
    if (!controller) continue;
    const controllerDecorator = decorators(controller).find(
      (d) => decoratorName(d) === 'Controller',
    )!;
    const prefix = stringArg(controllerDecorator).replace(/^\/+|\/+$/g, '');
    for (const method of controller.members.filter(ts.isMethodDeclaration)) {
      const route = decorators(method).find((d) =>
        ['Get', 'Post', 'Patch', 'Put', 'Delete', 'Options', 'Head'].includes(
          decoratorName(d) ?? '',
        ),
      );
      if (!route) continue;
      const httpMethod = decoratorName(route)!.toUpperCase();
      const suffix = stringArg(route).replace(/^\/+|\/+$/g, '');
      const request: Record<string, unknown> = {
        service: 'core',
        method: httpMethod,
        path: `/${[apiPrefix, prefix, suffix].filter(Boolean).join('/')}`,
        parameters: {},
      };
      for (const parameter of method.parameters) {
        for (const decorator of decorators(parameter)) {
          const kind = decoratorName(decorator);
          if (kind === 'Body' || kind === 'Query') {
            if (!parameter.type)
              throw new Error(
                `${source.fileName}: ${kind} parameter requires an explicit type.`,
              );
            request[kind === 'Body' ? 'body' : 'query'] = dtoFields(
              parameter.type,
            );
          }
          if (kind === 'Param') {
            const name = stringArg(decorator);
            const example = name.toLowerCase().includes('id')
              ? '00000000-0000-4000-8000-000000000001'
              : `${name}-example`;
            (request.parameters as Record<string, unknown>)[name] = {
              type: 'string',
              required: true,
              example,
            };
          }
        }
      }
      result.push(request);
    }
  }
  if (!result.length)
    throw new Error('No Core controller operations were found.');
  return result;
};

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  process.stdout.write(`${JSON.stringify(exportCoreContracts(), null, 2)}\n`);
}
