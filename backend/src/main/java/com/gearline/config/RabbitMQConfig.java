package com.gearline.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.amqp.core.*;
import org.springframework.amqp.rabbit.config.SimpleRabbitListenerContainerFactory;
import org.springframework.amqp.rabbit.connection.ConnectionFactory;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.amqp.support.converter.Jackson2JsonMessageConverter;
import org.springframework.amqp.support.converter.MessageConverter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.Map;

@Configuration
@RequiredArgsConstructor
public class RabbitMQConfig {

    private final GearlineProperties properties;

    // ── Dead Letter Exchange & Queue ───────────────────────────────────────────

    @Bean
    public DirectExchange deadLetterExchange() {
        return new DirectExchange(properties.getQueue().getDlxExchange(), true, false);
    }

    @Bean
    public Queue deadLetterQueue() {
        return QueueBuilder.durable(properties.getQueue().getDlqName()).build();
    }

    @Bean
    public Binding deadLetterBinding() {
        return BindingBuilder
            .bind(deadLetterQueue())
            .to(deadLetterExchange())
            .with(properties.getQueue().getSyncQueue());
    }

    // ── Main Sync Exchange & Queue ─────────────────────────────────────────────

    @Bean
    public TopicExchange syncExchange() {
        return new TopicExchange(properties.getQueue().getSyncExchange(), true, false);
    }

    @Bean
    public Queue syncJobQueue() {
        return QueueBuilder
            .durable(properties.getQueue().getSyncQueue())
            .withArguments(Map.of(
                "x-dead-letter-exchange", properties.getQueue().getDlxExchange(),
                "x-dead-letter-routing-key", properties.getQueue().getSyncQueue(),
                // Messages rejected after max retries will appear in DLQ after 1 hour
                "x-message-ttl", 3_600_000
            ))
            .build();
    }

    @Bean
    public Binding syncJobBinding() {
        return BindingBuilder
            .bind(syncJobQueue())
            .to(syncExchange())
            .with("sync.#");
    }

    // ── Message Serialization ──────────────────────────────────────────────────

    @Bean
    public MessageConverter jsonMessageConverter(ObjectMapper objectMapper) {
        return new Jackson2JsonMessageConverter(objectMapper);
    }

    @Bean
    public RabbitTemplate rabbitTemplate(ConnectionFactory connectionFactory, MessageConverter messageConverter) {
        RabbitTemplate template = new RabbitTemplate(connectionFactory);
        template.setMessageConverter(messageConverter);
        template.setMandatory(true);
        return template;
    }

    @Bean
    public SimpleRabbitListenerContainerFactory rabbitListenerContainerFactory(
        ConnectionFactory connectionFactory,
        MessageConverter messageConverter
    ) {
        SimpleRabbitListenerContainerFactory factory = new SimpleRabbitListenerContainerFactory();
        factory.setConnectionFactory(connectionFactory);
        factory.setMessageConverter(messageConverter);
        factory.setPrefetchCount(5);
        factory.setDefaultRequeueRejected(false); // Send to DLQ on failure
        return factory;
    }
}
