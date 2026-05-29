FROM maven:3.9-eclipse-temurin-21-alpine AS builder

WORKDIR /app

# Copy the POM first and resolve all dependencies into the local repository.
# This layer is cached and only re-runs when pom.xml changes, not when source changes.
# dependency:go-offline fetches project deps; dependency:resolve-plugins fetches annotation
# processor jars (Lombok, MapStruct) used by maven-compiler-plugin annotationProcessorPaths.
COPY pom.xml ./
RUN mvn dependency:go-offline dependency:resolve-plugins -q

# Now copy source and build. Separated so source changes don't bust the dep cache.
COPY src ./src
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
