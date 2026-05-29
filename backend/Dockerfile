FROM eclipse-temurin:21-jdk-alpine AS builder

WORKDIR /app

COPY pom.xml ./
COPY src ./src

RUN apk add --no-cache maven && \
    mvn dependency:go-offline -q

RUN mvn package -DskipTests -q

FROM eclipse-temurin:21-jre-alpine

WORKDIR /app

RUN addgroup -S gearline && adduser -S gearline -G gearline

COPY --from=builder /app/target/*.jar app.jar

RUN chown gearline:gearline app.jar

USER gearline

EXPOSE 8080

ENTRYPOINT ["java", \
  "-XX:+UseContainerSupport", \
  "-XX:MaxRAMPercentage=75.0", \
  "-jar", "app.jar"]
