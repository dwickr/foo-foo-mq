var _ = require( 'lodash' );
var AckBatch = require( '../ackBatch.js' );
var postal = require( 'postal' );
var dispatch = postal.channel( 'rabbit.dispatch' );
var responses = postal.channel( 'rabbit.responses' );
var when = require( 'when' );
var log = require( '../log.js' )( 'wascally:amqp-queue' );
var topLog = require( '../log.js' )( 'wascally:topology' );
var unhandledLog = require( '../log.js' )( 'wascally:unhandled' );
var noOp = function() {};

function aliasOptions( options, aliases ) {
	var aliased = _.transform( options, function( result, value, key ) {
		var alias = aliases[ key ];
		result[ alias || key ] = value;
	} );
	return _.omit( aliased, Array.prototype.slice.call( arguments, 2 ) );
}

function define( channel, options, subscriber, connectionName ) {
	var valid = aliasOptions( options, {
		queuelimit: 'maxLength',
		queueLimit: 'maxLength',
		deadletter: 'deadLetterExchange',
		deadLetter: 'deadLetterExchange'
	}, 'subscribe', 'limit' );
	topLog.info( 'Declaring queue \'%s\' on connection \'%s\' with the options: %s', options.name, connectionName, JSON.stringify( _.omit( options, [ 'name' ] ) ) );
	return channel.assertQueue( options.name, valid )
		.then( function( q ) {
			if ( options.limit ) {
				channel.prefetch( options.limit );
			}
			if ( options.subscribe ) {
				subscriber();
			}
			return q;
		} );
}

function destroy( channel, messages, released ) {
	unsubscribe( channel );
	return when.promise( function( resolve ) {
		var destroy = function() {
			channel.destroy();
			messages.ignoreSignal();
			channel = undefined;
			resolve();
		};
		if ( channel.hasPendingMessages && !released ) {
			messages.once( 'empty', function() {
				destroy();
			} );
		} else {
			destroy();
		}
	} );
}

function getChannel( connection ) {
	return connection.createChannel( true );
}

function getCount( messages ) {
	if ( messages ) {
		return messages.messages.length;
	} else {
		return 0;
	}
}

function getReply( channel, raw, replyQueue, connectionName ) {
	var position = 0;
	return function( reply, more, replyType ) {
		if ( _.isString( more ) ) {
			replyType = more;
			more = false;
		}
		var replyTo = raw.properties.replyTo;
		raw.ack();
		if ( replyTo ) {
			var payload = new Buffer( JSON.stringify( reply ) ),
				publishOptions = {
					type: replyType || raw.type + '.reply',
					contentType: 'application/json',
					contentEncoding: 'utf8',
					correlationId: raw.properties.messageId,
					replyTo: replyQueue,
					headers: {}
				};
			if ( !more ) {
				publishOptions.headers.sequence_end = true; // jshint ignore:line
			} else {
				publishOptions.headers.position = ( position++ );
			}
			log.debug( 'Replying to message %s on %s - %s with type %s',
				raw.properties.messageId,
				replyQueue,
				connectionName,
				publishOptions.type );
			if ( raw.properties.headers[ 'direct-reply-to' ] ) {
				return channel.publish(
					'',
					replyTo,
					payload,
					publishOptions
				);
			} else {
				return channel.sendToQueue( replyTo, payload, publishOptions );
			}
		}
	};
}

function getTrackedOps( raw, messages ) {
	return messages.getMessageOps( raw.fields.deliveryTag );
}

function getUntrackedOps( channel, raw, messages ) {
	messages.receivedCount += 1;
	return {
		ack: noOp,
		nack: function() {
			log.debug( 'Nacking tag %d on %s - %s', raw.fields.deliveryTag, messages.name, messages.connectionName );
			channel.nack( { fields: { deliveryTag: raw.fields.deliveryTag } }, false );
		},
		reject: function() {
			log.debug( 'Rejecting tag %d on %s - %s', raw.fields.deliveryTag, messages.name, messages.connectionName );
			channel.nack( { fields: { deliveryTag: raw.fields.deliveryTag } }, false, false );
		}
	};
}

function resolveTags( channel, queue, connection ) {
	return function( op, data ) {
		switch (op) {
			case 'ack':
				log.debug( 'Acking tag %d on %s - %s', data.tag, queue, connection );
				return channel.ack( { fields: { deliveryTag: data.tag } }, data.inclusive );
			case 'nack':
				log.debug( 'Nacking tag %d on %s - %s', data.tag, queue, connection );
				return channel.nack( { fields: { deliveryTag: data.tag } }, data.inclusive );
			case 'reject':
				log.debug( 'Rejecting tag %d on %s - %s', data.tag, queue, connection );
				return channel.nack( { fields: { deliveryTag: data.tag } }, data.inclusive, false );
			case 'empty':
				channel.hasPendingMessages = false;
				break;
		}
	};
}

function subscribe( channelName, channel, topology, messages, options ) {
	if ( !options.noAck ) {
		messages.listenForSignal();
	}
	log.info( 'Starting subscription %s - %s', channelName, topology.connection.name );
	return channel.consume( channelName, function( raw ) {
		var correlationId = raw.properties.correlationId;
		raw.body = JSON.parse( raw.content.toString( 'utf8' ) );
		var ops = options.noAck ? getUntrackedOps( channel, raw, messages ) : getTrackedOps( raw, messages );
		raw.ack = ops.ack;
		raw.nack = ops.nack;
		raw.reject = ops.reject;
		raw.reply = getReply( channel, raw, topology.replyQueue.name, topology.connection.name );
		raw.type = raw.properties.type;
		if ( raw.fields.routingKey === topology.replyQueue.name ) {
			responses.publish( correlationId, raw );
		} else {
			dispatch.publish( raw.type, raw, function( data ) {
				if ( data.activated && !ops.noAck ) {
					channel.hasPendingMessages = true;
					messages.addMessage( ops.message );
				} else {
					unhandledLog.warn( 'Message of %s on queue %s - %s was not processed by any registered handlers',
						raw.type,
						channelName,
						topology.connection.name
					);
					topology.onUnhandled( raw );
				}
			} );
		}
	}, options );
}

function unsubscribe( channel ) {
	if ( channel.tag ) {
		return channel.cancel( channel.tag );
	}
}

module.exports = function( options, topology ) {
	var channel = getChannel( topology.connection );
	var messages = new AckBatch( options.name, topology.connection.name, resolveTags( channel, options.name, topology.connection.name ) );
	var subscriber = subscribe.bind( undefined, options.name, channel, topology, messages, options );

	return {
		channel: channel,
		messages: messages,
		define: define.bind( undefined, channel, options, subscriber, topology.connection.name ),
		destroy: destroy.bind( undefined, channel, messages ),
		getMessageCount: getCount.bind( undefined, messages ),
		subscribe: subscriber,
		unsubscribe: unsubscribe.bind( undefined, channel, messages )
	};
};
