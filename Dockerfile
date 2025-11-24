# Use uma versão leve do Node compatível com seu package.json
FROM node:20-alpine

# Instala dependências do sistema necessárias para algumas libs (opcional, mas recomendado para canvas/baileys)
RUN apk add --no-cache git python3 make g++

# Define o diretório de trabalho
WORKDIR /app

# Copia os arquivos de dependência
COPY package*.json ./

# Instala as dependências (modo produção para ficar mais leve)
RUN npm install --production

# Copia o resto do código
COPY . .

# Expõe a porta da API
EXPOSE 3000

# Comando para iniciar
CMD ["npm", "start"]